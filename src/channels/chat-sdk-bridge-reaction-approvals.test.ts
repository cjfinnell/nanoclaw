/**
 * Reaction approvals (config.reactionApprovals): approve/reject questions post
 * as one plain-text line, and a 👍 / 👎 reaction on that message decides them.
 * Dispatch runs through the REAL Chat instance via the bridge's `_chat` seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, Chat } from 'chat';

import { createChatSdkBridge } from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

const APPROVAL_OPTIONS = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
  { label: 'Reject with reason…', selectedLabel: '📝 Rejected (awaiting reason)', value: 'reject_with_reason' },
];
const QUESTION = 'Agent "Terminal Agent" wants to run:\n`ncl groups-update --name Web Dev --id ag-1`';

function stubAdapter() {
  const postMessage = vi.fn(async () => ({ id: '$evt1' }));
  const editMessage = vi.fn(async () => ({ id: '$evt1' }));
  const adapter = {
    name: 'matrix',
    initialize: async () => {},
    postMessage,
    editMessage,
    channelIdFromThreadId: (tid: string) => tid,
  } as unknown as Adapter;
  return { adapter, postMessage, editMessage };
}

async function dispatch(fire: (options: { waitUntil: (p: Promise<unknown>) => void }) => void): Promise<void> {
  let task: Promise<unknown> | undefined;
  fire({
    waitUntil: (p) => {
      task = p;
    },
  });
  await task;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chatOf = (bridge: unknown): Chat => (bridge as any)._chat as Chat;

async function setupBridge(reactionApprovals: boolean) {
  const { adapter, postMessage, editMessage } = stubAdapter();
  const onAction = vi.fn();
  const onInbound = vi.fn();
  const bridge = createChatSdkBridge({ adapter, supportsThreads: false, reactionApprovals });
  await bridge.setup({ onInbound, onInboundEvent: () => {}, onMetadata: () => {}, onAction });
  return { adapter, bridge, postMessage, editMessage, onAction, onInbound };
}

async function deliverApproval(bridge: Awaited<ReturnType<typeof setupBridge>>['bridge']) {
  const { createPendingApproval } = await import('../db/sessions.js');
  await createPendingApproval({
    approval_id: 'appr-1',
    request_id: 'appr-1',
    action: 'cli_command',
    payload: '{}',
    created_at: new Date().toISOString(),
    title: 'CLI: groups-update',
    question: QUESTION,
    options_json: JSON.stringify(APPROVAL_OPTIONS),
  });
  return bridge.deliver('matrix:!room:server', null, {
    kind: 'chat-sdk',
    content: {
      type: 'ask_question',
      questionId: 'appr-1',
      title: 'CLI: groups-update',
      question: QUESTION,
      options: APPROVAL_OPTIONS,
    },
  });
}

function react(adapter: Adapter, bridge: unknown, rawEmoji: string, name: string, messageId = '$evt1') {
  return dispatch((options) =>
    chatOf(bridge).processReaction(
      {
        adapter,
        threadId: 'matrix:!room:server',
        messageId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        emoji: { name } as any,
        rawEmoji,
        added: true,
        user: { userId: '@user:example.org', userName: 'Connor', fullName: 'Connor', isBot: false, isMe: false },
        raw: {},
      },
      options,
    ),
  );
}

beforeEach(async () => {
  const { initTestDb } = await import('../db/connection.js');
  const { runMigrations } = await import('../db/migrations/index.js');
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  const { closeDb } = await import('../db/connection.js');
  await closeDb();
});

describe('reaction approvals', () => {
  it('posts a one-line prompt and binds it to the approval row', async () => {
    const { bridge, postMessage } = await setupBridge(true);
    expect(await deliverApproval(bridge)).toBe('$evt1');
    expect(postMessage).toHaveBeenCalledWith('matrix:!room:server', {
      markdown:
        'Agent "Terminal Agent" wants to run `ncl groups-update --name Web Dev --id ag-1`\n\n👍 approve · 👎 reject',
    });
    const { getPendingApproval } = await import('../db/sessions.js');
    expect((await getPendingApproval('appr-1'))?.platform_message_id).toBe('$evt1');
    await bridge.teardown();
  });

  it('👍 approves, edits the prompt to show the outcome', async () => {
    const { adapter, bridge, editMessage, onAction } = await setupBridge(true);
    await deliverApproval(bridge);
    await react(adapter, bridge, '👍️', 'thumbs_up');
    expect(onAction).toHaveBeenCalledWith(
      'appr-1',
      'approve',
      '@user:example.org',
      expect.objectContaining({ messageId: '$evt1' }),
    );
    expect(editMessage).toHaveBeenCalledWith('matrix:!room:server', '$evt1', {
      markdown:
        'Agent "Terminal Agent" wants to run `ncl groups-update --name Web Dev --id ag-1`\n\n✅ Approved by Connor',
    });
    await bridge.teardown();
  });

  it('👎 rejects', async () => {
    const { adapter, bridge, onAction } = await setupBridge(true);
    await deliverApproval(bridge);
    await react(adapter, bridge, '👎', 'thumbs_down');
    expect(onAction).toHaveBeenCalledWith('appr-1', 'reject', '@user:example.org', expect.anything());
    await bridge.teardown();
  });

  it('ignores other emoji and reactions on unrelated messages', async () => {
    const { adapter, bridge, onAction } = await setupBridge(true);
    await deliverApproval(bridge);
    await react(adapter, bridge, '❤️', 'heart');
    await react(adapter, bridge, '👍', 'thumbs_up', '$other');
    expect(onAction).not.toHaveBeenCalled();
    await bridge.teardown();
  });

  it('forwards other reactions to the agent as inbound messages', async () => {
    const { adapter, bridge, onAction, onInbound } = await setupBridge(true);
    await deliverApproval(bridge);
    await react(adapter, bridge, '❤️', 'heart', '$agentmsg');
    expect(onAction).not.toHaveBeenCalled();
    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(onInbound).toHaveBeenCalledWith(
      'matrix:!room:server',
      'matrix:!room:server',
      expect.objectContaining({
        kind: 'chat-sdk',
        isMention: true,
        content: expect.objectContaining({
          text: '[Reaction ❤️ to message $agentmsg]',
          reaction: { emoji: '❤️', messageId: '$agentmsg' },
          senderId: '@user:example.org',
        }),
      }),
    );
    await bridge.teardown();
  });

  it('forwards 👍 on a non-approval message, but not on an approval prompt', async () => {
    const { adapter, bridge, onInbound } = await setupBridge(true);
    await deliverApproval(bridge);
    await react(adapter, bridge, '👍', 'thumbs_up', '$other');
    expect(onInbound).toHaveBeenCalledTimes(1);
    await react(adapter, bridge, '👍', 'thumbs_up');
    expect(onInbound).toHaveBeenCalledTimes(1);
    await bridge.teardown();
  });

  it('forwards reactions when reactionApprovals is off', async () => {
    const { adapter, bridge, onInbound } = await setupBridge(false);
    await react(adapter, bridge, '👍', 'thumbs_up');
    expect(onInbound).toHaveBeenCalledTimes(1);
    await bridge.teardown();
  });

  it('still posts a button card when reactionApprovals is off', async () => {
    const { bridge, postMessage } = await setupBridge(false);
    await deliverApproval(bridge);
    expect(postMessage).toHaveBeenCalledWith(
      'matrix:!room:server',
      expect.objectContaining({ card: expect.anything() }),
    );
    await bridge.teardown();
  });
});

describe('repostUnboundReactionApprovals', () => {
  it('re-sends unbound approvals as reaction prompts and binds them', async () => {
    const { createPendingApproval, getPendingApproval } = await import('../db/sessions.js');
    const { repostUnboundReactionApprovals } = await import('./chat-sdk-bridge.js');
    await createPendingApproval({
      approval_id: 'appr-old',
      request_id: 'appr-old',
      action: 'cli_command',
      payload: '{}',
      created_at: new Date().toISOString(),
      channel_type: 'matrix',
      platform_id: 'matrix:@user:example.org',
      title: 'CLI: groups-update',
      question: QUESTION,
      options_json: JSON.stringify(APPROVAL_OPTIONS),
    });
    const { adapter, postMessage } = stubAdapter();
    await repostUnboundReactionApprovals(adapter, 'matrix');
    expect(postMessage).toHaveBeenCalledWith('matrix:@user:example.org', {
      markdown:
        'Agent "Terminal Agent" wants to run `ncl groups-update --name Web Dev --id ag-1`\n\n👍 approve · 👎 reject',
    });
    expect((await getPendingApproval('appr-old'))?.platform_message_id).toBe('$evt1');
    // Bound now, so a second pass sends nothing.
    await repostUnboundReactionApprovals(adapter, 'matrix');
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});
