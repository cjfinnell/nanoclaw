/**
 * Matrix channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Supports two auth methods (resolved by the adapter from env):
 *   - Access token: MATRIX_ACCESS_TOKEN + MATRIX_USER_ID
 *   - Password:     MATRIX_USERNAME + MATRIX_PASSWORD (+ optional MATRIX_USER_ID)
 *
 * Optional env vars:
 *   MATRIX_BOT_USERNAME         — display name for the bot (default: "bot")
 *   MATRIX_INVITE_AUTOJOIN      — "true" to auto-accept room invites
 *   MATRIX_INVITE_AUTOJOIN_ALLOWLIST — comma-separated user IDs allowed to invite
 *   MATRIX_RECOVERY_KEY         — enable E2EE cross-signing
 *   MATRIX_DEVICE_ID            — stable device ID across restarts
 *   WHISPER_URL                 — whisper.cpp server; transcribes voice notes
 */
import fs from 'fs';
import { createMatrixAdapter, type MatrixAdapterConfig } from '@beeper/chat-adapter-matrix';

import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';
import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge, repostUnboundReactionApprovals } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';
import { MatrixCryptoStore, type MatrixDeviceSession } from './matrix-crypto-store.js';
import { createWhisperTranscriber } from './transcribe.js';
import { defaultEmojiResolver } from 'chat';

/**
 * Assumes a dedicated bot account on a homeserver (the common install).
 * Non-threaded at the bridge level, so group engagement is 'mention', never
 * sticky. Personal-account installs should edit their copy to dm 'strict' —
 * install-wide changes live in this declaration by design.
 */
const MATRIX_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

const ENV_KEYS = [
  'MATRIX_BASE_URL',
  'MATRIX_ACCESS_TOKEN',
  'MATRIX_USERNAME',
  'MATRIX_PASSWORD',
  'MATRIX_USER_ID',
  'MATRIX_BOT_USERNAME',
  'MATRIX_DEVICE_ID',
  'MATRIX_RECOVERY_KEY',
  'MATRIX_INVITE_AUTOJOIN',
  'MATRIX_INVITE_AUTOJOIN_ALLOWLIST',
  'WHISPER_URL',
  'LITELLM_SERVED_MODEL_FILE',
] as const;

/** Fallback tags older than this are ignored (the local model takes ~7 min per reply). */
const FALLBACK_TAG_MAX_AGE_MS = 20 * 60 * 1000;

/**
 * First line for a reply served by a fallback model, or null on Opus. LiteLLM's
 * tag_fallback.py records the serving model for Terminal Agent's requests in
 * LITELLM_SERVED_MODEL_FILE; adding the line here keeps it out of the agent's transcript,
 * where the agents copied it, and inside what Beeper actually shows.
 */
function fallbackTagLine(): string | null {
  const file = process.env.LITELLM_SERVED_MODEL_FILE;
  if (!file) return null;
  try {
    const { tag, ts } = JSON.parse(fs.readFileSync(file, 'utf8')) as { tag: string | null; ts: number };
    if (!tag || Date.now() - ts * 1000 > FALLBACK_TAG_MAX_AGE_MS) return null;
    return `🤡 \`${tag}\` 🤡`;
  } catch {
    return null;
  }
}

/** Prepend the fallback line to the plain-text forms of a postable message; cards pass through. */
function withFallbackTag<T>(message: T): T {
  const line = fallbackTagLine();
  if (!line) return message;
  if (typeof message === 'string') return `${line}\n${message}` as T;
  const m = message as { markdown?: unknown; raw?: unknown };
  if (m && typeof m === 'object') {
    if (typeof m.markdown === 'string') return { ...m, markdown: `${line}\n\n${m.markdown}` } as T;
    if (typeof m.raw === 'string') return { ...m, raw: `${line}\n${m.raw}` } as T;
  }
  return message;
}

/**
 * Matrix reactions need the emoji itself as the annotation key; the adapter
 * sends whatever string it is given, so a name like "thumbs_up" showed as text
 * in Beeper. Names the Chat SDK knows are resolved to the emoji; real emoji and
 * unknown names pass through unchanged. There is no official snake_case name
 * list (Unicode only names emoji "cat face", "cat"), so agents are told to send
 * the emoji character itself (add_reaction in container/agent-runner).
 */
function matrixReactionKey(emoji: unknown): unknown {
  if (typeof emoji !== 'string' || !/^[a-z0-9_+-]+$/i.test(emoji)) return emoji;
  const name = emoji.toLowerCase();
  const resolved = defaultEmojiResolver.toGChat(name);
  return resolved !== name ? resolved : emoji;
}

/**
 * Wrap the Matrix adapter so DM conversations are identified by user handle
 * across the whole system, not by ephemeral room IDs.
 *
 * Matrix DMs live in rooms (e.g. "!abc:server"), but NanoClaw identifies
 * channels by platform_id. Using a user handle as platform_id means both
 * the user and the messaging group reference the same stable identifier.
 *
 * Two directions to bridge:
 *   - Outbound: delivery passes "matrix:@user:server" → resolve to room via openDM
 *   - Inbound: adapter emits "matrix:!room:server" → rewrite to user handle
 *     so the router finds the existing messaging group instead of creating
 *     a new one.
 *
 * Both resolutions are cached for the process lifetime.
 */
function wrapWithDmResolution(adapter: ReturnType<typeof createMatrixAdapter>): typeof adapter {
  const origPostMessage = adapter.postMessage.bind(adapter);
  const origStartTyping = adapter.startTyping.bind(adapter);
  const origAddReaction = adapter.addReaction.bind(adapter);
  const origRemoveReaction = adapter.removeReaction.bind(adapter);
  const origEditMessage = adapter.editMessage.bind(adapter);
  const origChannelIdFromThreadId = adapter.channelIdFromThreadId.bind(adapter);

  // roomId → user handle, used to rewrite inbound channel IDs.
  const roomToUserCache = new Map<string, string>();

  function isUserHandle(threadId: string): boolean {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      return !roomID.startsWith('!');
    } catch {
      return true;
    }
  }

  async function resolveThreadId(threadId: string): Promise<string> {
    if (!isUserHandle(threadId)) return threadId;

    const userHandle = threadId.startsWith('matrix:') ? threadId.slice('matrix:'.length) : threadId;
    log.info('Matrix: resolving DM room for user handle', { userHandle });
    const resolved = await adapter.openDM(userHandle);

    try {
      const { roomID } = adapter.decodeThreadId(resolved);
      roomToUserCache.set(roomID, userHandle);
    } catch {
      // decode failure is non-fatal — outbound still works
    }

    return resolved;
  }

  // Rewrite inbound room-based channel IDs to user-handle form for DM rooms.
  // Non-DM rooms pass through unchanged.
  adapter.channelIdFromThreadId = (threadId: string): string => {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      if (!roomID.startsWith('!')) return origChannelIdFromThreadId(threadId);

      const cached = roomToUserCache.get(roomID);
      if (cached) return `matrix:${cached}`;

      // Not cached — check if this is a DM by membership count
      const client = (adapter as any).client;
      const room = client?.getRoom(roomID);
      if (!room) return origChannelIdFromThreadId(threadId);
      if (room.getJoinedMemberCount() > 2) return origChannelIdFromThreadId(threadId);

      const botId = (adapter as any).userID;
      const otherMember = room.getJoinedMembers().find((m: { userId: string }) => m.userId !== botId);
      if (!otherMember) return origChannelIdFromThreadId(threadId);

      roomToUserCache.set(roomID, otherMember.userId);
      return `matrix:${otherMember.userId}`;
    } catch {
      return origChannelIdFromThreadId(threadId);
    }
  };

  // The Chat SDK calls adapter.isDM(threadId) synchronously to decide whether
  // to dispatch to onDirectMessage handlers. The Matrix adapter doesn't expose
  // this method — it only has an async isDirectRoom(). We add a synchronous
  // isDM that checks room membership count: 2 members = DM.
  (adapter as any).isDM = (threadId: string): boolean => {
    try {
      const { roomID } = adapter.decodeThreadId(threadId);
      const client = (adapter as any).client;
      if (!client) return false;
      const room = client.getRoom(roomID);
      if (!room) return false;
      const members = room.getJoinedMemberCount();
      return members <= 2;
    } catch {
      return false;
    }
  };

  // Inbound trace: the adapter logs received events only at debug level, so a
  // message that reaches sync but never becomes "Inbound DM received" left no
  // trace (admin ticket "Terminal Agent replies not reaching Connor"). Log each
  // human message event on entry and exit, and warn if it never finishes.
  const origOnTimelineEvent = (adapter as any).onTimelineEvent.bind(adapter);
  (adapter as any).onTimelineEvent = async (event: any, room: any, toStartOfTimeline: boolean) => {
    const type: string = event.getType();
    const sender: string | undefined = event.getSender();
    const botId = (adapter as any).userID;
    if ((type !== 'm.room.encrypted' && type !== 'm.room.message') || !sender || sender === botId) {
      return origOnTimelineEvent(event, room, toStartOfTimeline);
    }
    const eventId: string | undefined = event.getId();
    const started = Date.now();
    log.info('Matrix: inbound event', { eventId, type, sender, toStartOfTimeline });
    const watchdog = setTimeout(() => {
      log.warn('Matrix: inbound event still pending after 15s', {
        eventId,
        clearType: event.getType(),
        beingDecrypted: event.isBeingDecrypted?.(),
      });
    }, 15_000);
    watchdog.unref();
    try {
      await origOnTimelineEvent(event, room, toStartOfTimeline);
      log.info('Matrix: inbound event dispatched', {
        eventId,
        clearType: event.getType(),
        decryptionFailure: event.isDecryptionFailure?.() ?? false,
        ms: Date.now() - started,
      });
    } catch (err) {
      log.error('Matrix: inbound event failed', { eventId, err });
      throw err;
    } finally {
      clearTimeout(watchdog);
    }
  };

  adapter.postMessage = async (
    threadId: string,
    ...args: Parameters<typeof origPostMessage> extends [string, ...infer R] ? R : never
  ) => {
    const resolvedTid = await resolveThreadId(threadId);
    const [message, ...rest] = args;
    return origPostMessage(resolvedTid, withFallbackTag(message), ...rest);
  };

  adapter.startTyping = async (threadId: string) => {
    const resolvedTid = await resolveThreadId(threadId);
    return origStartTyping(resolvedTid);
  };

  // Reactions and edits arrive with the same "matrix:@user:server" channel ID
  // as posts; without resolving it the adapter reads "@user" as the room.
  adapter.addReaction = async (threadId: string, messageId: string, emoji: Parameters<typeof origAddReaction>[2]) =>
    origAddReaction(await resolveThreadId(threadId), messageId, matrixReactionKey(emoji) as typeof emoji);
  adapter.removeReaction = async (
    threadId: string,
    messageId: string,
    emoji: Parameters<typeof origRemoveReaction>[2],
  ) => origRemoveReaction(await resolveThreadId(threadId), messageId, matrixReactionKey(emoji) as typeof emoji);
  adapter.editMessage = async (threadId: string, messageId: string, message: Parameters<typeof origEditMessage>[2]) =>
    origEditMessage(await resolveThreadId(threadId), messageId, message);

  return adapter;
}

/** Display name stamped on the device this adapter logs in. */
const E2EE_DEVICE_NAME = 'NanoClaw';

/** Crypto store and login of the bot's one device, kept across restarts. */
const CRYPTO_STORE_FILE = path.join(DATA_DIR, 'matrix', 'crypto-store.bin');

/**
 * E2EE config for Node. The crypto store lives in IndexedDB, which Node lacks;
 * matrix-crypto-store.ts provides it and saves it to disk. Login starts as a
 * password login, and the initialize wrapper below swaps in the saved access
 * token when the snapshot is usable. The adapter's own session persistence
 * stays off (TTL 1ms): it would reuse a token without the keys that go with it.
 * Its saved /sync snapshot stays off too: a snapshot can lose a room's state,
 * and a room loaded without m.room.encryption is never registered with the
 * crypto, so every send fails with "Cannot encrypt event in unconfigured room".
 */
function buildE2eeConfig(recoveryKey: string): MatrixAdapterConfig | null {
  const { MATRIX_BASE_URL, MATRIX_USERNAME, MATRIX_PASSWORD } = process.env;
  if (!MATRIX_BASE_URL || !MATRIX_USERNAME || !MATRIX_PASSWORD) {
    log.error('Matrix: MATRIX_RECOVERY_KEY needs MATRIX_USERNAME + MATRIX_PASSWORD — E2EE disabled');
    return null;
  }
  const inviterAllowlist = (process.env.MATRIX_INVITE_AUTOJOIN_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    baseURL: MATRIX_BASE_URL,
    auth: {
      type: 'password',
      username: MATRIX_USERNAME,
      password: MATRIX_PASSWORD,
      userID: process.env.MATRIX_USER_ID,
      initialDeviceDisplayName: E2EE_DEVICE_NAME,
    },
    userName: process.env.MATRIX_BOT_USERNAME ?? 'bot',
    recoveryKey,
    e2ee: { useIndexedDB: true },
    persistence: { session: { ttlMs: 1 }, sync: { snapshotTtlMs: 1 } },
    inviteAutoJoin: process.env.MATRIX_INVITE_AUTOJOIN === 'true' ? { inviterAllowlist } : undefined,
    matrixSDKLogLevel: 'error',
  };
}

/**
 * After the adapter starts: cross-sign the fresh device (cross-signing keys come
 * out of secret storage via the recovery key), so clients that exclude
 * unverified devices still encrypt to it. Best-effort — failures log and the
 * bot keeps running. The signature takes a moment to show up in the device's
 * own view, so verification is confirmed on a delayed recheck.
 */
async function finishE2eeSetup(adapter: ReturnType<typeof createMatrixAdapter>): Promise<void> {
  const client = (adapter as any).client;
  const crypto = client?.getCrypto?.();
  if (!crypto) {
    log.warn('Matrix: E2EE requested but crypto did not initialize');
    return;
  }
  const userId: string = client.getUserId();
  const deviceId: string = client.getDeviceId();

  try {
    // A fresh device hasn't queried its own identity yet; importing the private
    // keys from secret storage fails unless the public ones are known first.
    await crypto.userHasCrossSigningKeys(userId, true);
    await crypto.bootstrapCrossSigning({
      authUploadDeviceSigningKeys: async (makeRequest: (auth: unknown) => Promise<unknown>) => {
        await makeRequest({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: process.env.MATRIX_USERNAME },
          password: process.env.MATRIX_PASSWORD,
        });
      },
    });
  } catch (err) {
    log.warn('Matrix: cross-signing the bot device failed — some clients may not encrypt to it', { err });
    return;
  }

  setTimeout(async () => {
    try {
      await crypto.userHasCrossSigningKeys(userId, true);
      const status = await crypto.getDeviceVerificationStatus(userId, deviceId);
      if (status?.crossSigningVerified) log.info('Matrix: E2EE device ready', { deviceId });
      else log.warn('Matrix: E2EE device is not cross-signed — some clients may not encrypt to it', { deviceId });
    } catch (err) {
      log.warn('Matrix: E2EE device verification check failed', { err });
    }
  }, 10_000).unref();
}

/**
 * Restore the saved device if its access token still works. A token the
 * homeserver rejects (device signed out by hand) discards the snapshot, so the
 * adapter logs in a new device. Any other failure keeps it: a network blip at
 * boot must not throw away the device.
 */
async function restoreDevice(store: MatrixCryptoStore, baseURL: string): Promise<MatrixDeviceSession | null> {
  const session = await store.restore();
  if (!session) return null;
  let res: Response;
  try {
    res = await fetch(new URL('/_matrix/client/v3/account/whoami', baseURL), {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
  } catch (err) {
    log.warn('Matrix: could not check saved device — reusing it', { err, deviceId: session.deviceId });
    return session;
  }
  if (res.status === 401) {
    log.warn('Matrix: saved device was signed out — starting a new device', { deviceId: session.deviceId });
    await store.discard();
    return null;
  }
  if (res.ok) {
    const whoami = (await res.json()) as { device_id?: string };
    if (whoami.device_id !== session.deviceId) {
      log.warn('Matrix: saved token belongs to another device — starting a new device', {
        deviceId: session.deviceId,
        tokenDeviceId: whoami.device_id,
      });
      await store.discard();
      return null;
    }
  }
  return session;
}

registerChannelAdapter('matrix', {
  factory: () => {
    const env = readEnvFile([...ENV_KEYS]);
    if (!env.MATRIX_BASE_URL) return null;
    if (!env.MATRIX_ACCESS_TOKEN && !(env.MATRIX_USERNAME && env.MATRIX_PASSWORD)) return null;

    for (const key of ENV_KEYS) {
      if (env[key]) process.env[key] = env[key];
    }

    // Default: auto-join room invites so DMs work without manual acceptance
    if (!process.env.MATRIX_INVITE_AUTOJOIN) {
      process.env.MATRIX_INVITE_AUTOJOIN = 'true';
    }

    const e2eeConfig = process.env.MATRIX_RECOVERY_KEY ? buildE2eeConfig(process.env.MATRIX_RECOVERY_KEY) : null;
    if (!e2eeConfig) delete process.env.MATRIX_RECOVERY_KEY; // env path would hit the IndexedDB crash
    const matrixAdapter = wrapWithDmResolution(e2eeConfig ? createMatrixAdapter(e2eeConfig) : createMatrixAdapter());
    if (e2eeConfig) {
      const cryptoStore = new MatrixCryptoStore(CRYPTO_STORE_FILE);
      const origInitialize = matrixAdapter.initialize.bind(matrixAdapter);
      matrixAdapter.initialize = async (chat) => {
        const saved = await restoreDevice(cryptoStore, e2eeConfig.baseURL);
        if (saved) {
          (matrixAdapter as any).auth = { type: 'accessToken', accessToken: saved.accessToken, userID: saved.userId };
        }
        await origInitialize(chat);
        const client = (matrixAdapter as any).client;
        cryptoStore.track({
          userId: client.getUserId(),
          deviceId: client.getDeviceId(),
          accessToken: client.getAccessToken(),
        });
        log.info(saved ? 'Matrix: reusing saved E2EE device' : 'Matrix: logged in new E2EE device', {
          deviceId: client.getDeviceId(),
        });
        await finishE2eeSetup(matrixAdapter);
      };
      // Chat SDK teardown calls adapter.disconnect(), which this adapter lacks —
      // so its shutdown() never ran. Route disconnect through it, then save the
      // crypto store. The device stays logged in for the next start.
      (matrixAdapter as any).disconnect = async () => {
        try {
          await matrixAdapter.shutdown();
        } catch (err) {
          log.warn('Matrix: adapter shutdown failed', { err });
        }
        await cryptoStore.flush();
      };
    }
    const bridge = createChatSdkBridge({
      adapter: matrixAdapter,
      concurrency: 'concurrent',
      supportsThreads: false,
      defaults: MATRIX_DEFAULTS,
      // Beeper renders no card buttons, so approvals are decided by 👍 / 👎.
      reactionApprovals: true,
      // Agents have no speech tooling, so voice notes are transcribed here.
      transcribeAudio: process.env.WHISPER_URL ? createWhisperTranscriber(process.env.WHISPER_URL) : undefined,
    });

    // Matrix user IDs contain ":" (e.g. "@user:matrix.org") which the shared
    // permissions module interprets as already-prefixed. Wrap onInbound to
    // ensure senderId always carries the "matrix:" channel prefix so user
    // records match between init-first-agent and inbound routing.
    const origSetup = bridge.setup.bind(bridge);
    bridge.setup = async (hostConfig) => {
      const origOnInbound = hostConfig.onInbound.bind(hostConfig);
      await origSetup({
        ...hostConfig,
        onInbound: (platformId, threadId, message) => {
          if (message.content && typeof message.content === 'object') {
            const content = message.content as Record<string, unknown>;
            if (typeof content.senderId === 'string' && !content.senderId.startsWith('matrix:')) {
              content.senderId = `matrix:${content.senderId}`;
            }
          }
          return origOnInbound(platformId, threadId, message);
        },
        // Same prefix for card clicks and reaction approvals, so the approver
        // check matches the "matrix:@user:server" ID the approval was routed to.
        onAction: (questionId, selectedOption, userId, address) =>
          hostConfig.onAction(
            questionId,
            selectedOption,
            userId && !userId.startsWith('matrix:') ? `matrix:${userId}` : userId,
            address,
          ),
      });

      // Wait for Matrix sync to reach PREPARED state before returning from setup.
      // Without this, the host's delivery poll and sweep timer start immediately
      // and can starve the SDK's sync generator microtask queue, blocking
      // incremental syncs so new inbound messages never get dispatched.
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if ((matrixAdapter as unknown as { liveSyncReady?: boolean }).liveSyncReady) {
            log.info('Matrix sync ready');
            clearInterval(check);
            void repostUnboundReactionApprovals(matrixAdapter, 'matrix');
            resolve();
          }
        }, 500);
        setTimeout(() => {
          clearInterval(check);
          resolve();
        }, 30_000);
      });
    };

    return bridge;
  },
  defaults: MATRIX_DEFAULTS,
});
