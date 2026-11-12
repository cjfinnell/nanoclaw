/**
 * GitHub adapter — verify, then normalize to the generic envelope.
 *
 * The only place GitHub-specific knowledge lives (per the source-agnostic
 * contract): signature check, header parsing, subject-key construction.
 * Everything downstream (matching, rendering entry points, delivery) is
 * source-blind.
 *
 * Register at /webhook/github via registerWebhookHandler in ../index.ts.
 * Ingress: claw.cfin.dev/hooks/github → tunnel → :3000/webhook/github.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { log } from '../../../log.js';
import type { WebhookEvent } from '../event.js';

/** Hard cap on the request body — GitHub payloads stay far below this; the
 *  cap exists so a hostile/oversized POST can't buffer unbounded memory
 *  (upstream nanocoai/nanoclaw#2000 applies the same fix host-wide). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Constant-time HMAC-SHA256 check against x-hub-signature-256. */
export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** subject key for a repo-scoped event: github:repo:owner/name */
export function repoSubject(fullName: string): string {
  return `github:repo:${fullName}`;
}

/** subject key for a thread-scoped event (issue/PR): github:repo:owner/name#184 */
export function threadSubject(fullName: string, number: number): string {
  return `github:repo:${fullName}#${number}`;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Build the envelope from a verified payload. Returns undefined when the
 * event carries no repository (e.g. 'ping' from App settings) — those get
 * acknowledged but never routed.
 *
 * type = action ? `${event}.${action}` : event — the dotted form lets a
 * subscription filter match the exact type or the whole family.
 */
export function buildGithubEnvelope(
  event: string,
  body: Record<string, unknown>,
  deliveryId?: string,
): WebhookEvent | undefined {
  const repo = body.repository as Record<string, unknown> | undefined;
  const fullName = str(repo?.full_name);
  if (!fullName) return undefined;

  const action = str(body.action);
  const type = action ? `${event}.${action}` : event;

  // Thread pin: issues/PRs carry their number under issue|pull_request|
  // discussion; a `number` at top level (some events) also qualifies.
  const container = (body.issue ?? body.pull_request ?? body.discussion) as Record<string, unknown> | undefined;
  const number = typeof container?.number === 'number' ? container.number : undefined;
  const subject = number !== undefined ? threadSubject(fullName, number) : repoSubject(fullName);

  const senderLogin = str((body.sender as Record<string, unknown> | undefined)?.login);

  return { source: 'github', type, subject, payload: body, sender: senderLogin, deliveryId };
}

export interface GithubHandlerResult {
  status: number;
  json: { ok: boolean; matched?: number; reason?: string };
}

/**
 * Pure core of the raw HTTP handler — testable without sockets. Reads the
 * body under the cap, verifies the signature, normalizes, hands the
 * envelope to `onEvent`, and answers with a GitHub-deliveries-friendly
 * JSON status.
 */
export async function handleGithubRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { secret: string; onEvent: (event: WebhookEvent) => Promise<GithubHandlerResult> },
): Promise<void> {
  const finish = (status: number, payload: GithubHandlerResult['json']): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  let body: Buffer;
  try {
    body = await readBody(req);
  } catch (err) {
    if (err instanceof OversizeError) {
      finish(413, { ok: false, reason: 'payload too large' });
      return;
    }
    finish(400, { ok: false, reason: 'failed to read body' });
    return;
  }

  const event = req.headers['x-github-event'];
  const delivery = req.headers['x-github-delivery'];
  if (typeof event !== 'string' || event.length === 0) {
    finish(400, { ok: false, reason: 'missing x-github-event' });
    return;
  }

  if (!verifySignature(opts.secret, body, req.headers['x-hub-signature-256'] as string | undefined)) {
    log.warn('github webhook: signature verification failed', { event, delivery });
    finish(401, { ok: false, reason: 'bad signature' });
    return;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    finish(400, { ok: false, reason: 'invalid JSON' });
    return;
  }

  const envelope = buildGithubEnvelope(event, parsed, typeof delivery === 'string' ? delivery : undefined);
  if (!envelope) {
    // No repository (e.g. App 'ping') — acknowledge, never route.
    finish(200, { ok: true, reason: 'no repository; not routed' });
    return;
  }

  const result = await opts.onEvent(envelope);
  finish(result.status, result.json);
}

class OversizeError extends Error {}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new OversizeError();
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
