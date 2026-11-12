/**
 * GitHub adapter — signature verification, envelope normalization, and the
 * request handler's cap/status behavior. Pure functions plus a fake
 * req/res pair for handleGithubRequest; no sockets.
 */
import { createHmac } from 'node:crypto';
import { EventEmitter, PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import {
  MAX_BODY_BYTES,
  buildGithubEnvelope,
  handleGithubRequest,
  repoSubject,
  threadSubject,
  verifySignature,
} from './github.js';

const SECRET = 'test-secret';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

describe('verifySignature', () => {
  const body = Buffer.from('{"hello":1}');

  it('accepts a correct signature', () => {
    expect(verifySignature(SECRET, body, sign('{"hello":1}'))).toBe(true);
  });

  it('rejects a wrong secret, body, or missing header', () => {
    expect(verifySignature('other', body, sign('{"hello":1}'))).toBe(false);
    expect(verifySignature(SECRET, Buffer.from('{"hello":2}'), sign('{"hello":1}'))).toBe(false);
    expect(verifySignature(SECRET, body, undefined)).toBe(false);
  });
});

describe('buildGithubEnvelope', () => {
  const repo = { repository: { full_name: 'cjfinnell/homelab' } };

  it('pins the subject to the thread for issue/PR events', () => {
    const env = buildGithubEnvelope(
      'pull_request',
      { ...repo, action: 'opened', pull_request: { number: 184, title: 'Cutover' }, sender: { login: 'cjfinnell' } },
      'd-1',
    );
    expect(env).toMatchObject({
      source: 'github',
      type: 'pull_request.opened',
      subject: 'github:repo:cjfinnell/homelab#184',
      sender: 'cjfinnell',
      deliveryId: 'd-1',
    });
  });

  it('uses the repo subject and bare event when there is no action or thread', () => {
    const env = buildGithubEnvelope('push', repo);
    expect(env).toMatchObject({ type: 'push', subject: 'github:repo:cjfinnell/homelab' });
  });

  it('drops events with no repository (App ping)', () => {
    expect(buildGithubEnvelope('ping', { zen: 'Design for failure.' })).toBeUndefined();
  });
});

describe('subject helpers', () => {
  it('build repo and thread keys', () => {
    expect(repoSubject('a/b')).toBe('github:repo:a/b');
    expect(threadSubject('a/b', 7)).toBe('github:repo:a/b#7');
  });
});

// ── handleGithubRequest with fake req/res ──

function fakeReq(body: string, headers: Record<string, string>): IncomingMessage {
  const stream = new PassThrough();
  const req = stream as unknown as IncomingMessage;
  req.method = 'POST';
  req.url = '/webhook/github';
  (req as unknown as { headers: Record<string, string> }).headers = headers;
  stream.end(body);
  return req;
}

function fakeRes(): ServerResponse & { status?: number; body?: string } {
  const res = new EventEmitter() as unknown as ServerResponse & { status?: number; body?: string };
  res.writeHead = ((status: number) => {
    res.status = status;
    return res;
  }) as typeof res.writeHead;
  res.end = ((payload?: unknown) => {
    res.body = typeof payload === 'string' ? payload : '';
    res.emit('finish');
    return res;
  }) as typeof res.end;
  return res;
}

const repoPayload = JSON.stringify({
  repository: { full_name: 'cjfinnell/homelab' },
  action: 'opened',
  pull_request: { number: 184, title: 'T', html_url: 'https://example.com/p/1' },
  sender: { login: 'renovate[bot]' },
});

async function run(
  req: IncomingMessage,
  res: ServerResponse,
  onEvent = vi.fn(),
): Promise<{ status?: number; body?: string }> {
  await handleGithubRequest(req, res, { secret: SECRET, onEvent });
  return res as { status?: number; body?: string };
}

describe('handleGithubRequest', () => {
  it('verifies, normalizes, and forwards to onEvent', async () => {
    const onEvent = vi.fn().mockResolvedValue({ status: 200, json: { ok: true, matched: 1 } });
    const res = await run(
      fakeReq(repoPayload, {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'd-9',
        'x-hub-signature-256': sign(repoPayload),
      }),
      fakeRes(),
      onEvent,
    );
    expect(res.status).toBe(200);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0][0]).toMatchObject({
      source: 'github',
      type: 'pull_request.opened',
      subject: 'github:repo:cjfinnell/homelab#184',
    });
  });

  it('rejects a bad signature with 401 and never calls onEvent', async () => {
    const onEvent = vi.fn();
    const res = await run(
      fakeReq(repoPayload, {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=' + '0'.repeat(64),
      }),
      fakeRes(),
      onEvent,
    );
    expect(res.status).toBe(401);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('rejects a missing event header with 400', async () => {
    const res = await run(fakeReq(repoPayload, { 'x-hub-signature-256': sign(repoPayload) }), fakeRes());
    expect(res.status).toBe(400);
  });

  it('caps the body and answers 413', async () => {
    const big = 'x'.repeat(MAX_BODY_BYTES + 1);
    const res = await run(
      fakeReq(big, {
        'x-github-event': 'push',
        'x-hub-signature-256': sign(big),
      }),
      fakeRes(),
    );
    expect(res.status).toBe(413);
  });

  it('acknowledges repository-less events without routing', async () => {
    const ping = JSON.stringify({ zen: 'Keep it logically awesome.' });
    const onEvent = vi.fn();
    const res = await run(
      fakeReq(ping, { 'x-github-event': 'ping', 'x-hub-signature-256': sign(ping) }),
      fakeRes(),
      onEvent,
    );
    expect(res.status).toBe(200);
    expect(onEvent).not.toHaveBeenCalled();
  });
});
