/**
 * `ncl subscriptions` — row-building sugar, and the self-serve contract at
 * the dispatch level: own-group auto-fill, cross-group denial, list scoping,
 * idempotent create, thread-pin expiry default.
 */
import fs from 'fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-cli-subs',
    GROUPS_DIR: '/tmp/nanoclaw-test-cli-subs/groups',
    TIMEZONE: 'UTC',
  };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-cli-subs';

import { initTestDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import { buildSubscriptionRow, parseExpires } from './subscriptions.js';
import './subscriptions.js';

function now(): string {
  return new Date().toISOString();
}

async function createGroup(id: string): Promise<void> {
  await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

function agentCtx(group = 'ag-1'): CallerContext {
  return { caller: 'agent', agentGroupId: group, sessionId: 's-1', messagingGroupId: 'mg-1' };
}

const hostCtx: CallerContext = { caller: 'host' };

async function call(command: string, args: Record<string, unknown>, ctx: CallerContext) {
  return dispatch({ id: 't', command, args }, ctx);
}

describe('parseExpires', () => {
  it('parses durations, ISO, and none', () => {
    const base = new Date('2026-11-12T00:00:00Z');
    expect(parseExpires('7d', base)).toBe('2026-11-19T00:00:00.000Z');
    expect(parseExpires('12h', base)).toBe('2026-11-12T12:00:00.000Z');
    expect(parseExpires('none', base)).toBeNull();
    expect(parseExpires('2026-12-01T00:00:00Z', base)).toBe('2026-12-01T00:00:00.000Z');
  });

  it('throws on garbage', () => {
    expect(() => parseExpires('soon')).toThrow(/invalid --expires/);
  });
});

describe('buildSubscriptionRow', () => {
  it('compiles repo sugar into a repo-level glob', () => {
    const row = buildSubscriptionRow({ agent_group_id: 'ag-1', repo: 'cjfinnell/homelab' });
    expect(row.subject).toBe('github:repo:cjfinnell/homelab*');
    expect(row.source).toBe('github');
    expect(row.wake).toBe(1);
    expect(row.expires_at).toBeNull();
    expect(JSON.parse(row.event_types_json)).toEqual([]);
  });

  it('compiles repo+number into an exact thread subject with 7d expiry', () => {
    const row = buildSubscriptionRow({ agent_group_id: 'ag-1', repo: 'cjfinnell/homelab', number: 184 });
    expect(row.subject).toBe('github:repo:cjfinnell/homelab#184');
    expect(row.expires_at).not.toBeNull();
  });

  it('splits event types and honors wake=false', () => {
    const row = buildSubscriptionRow({
      agent_group_id: 'ag-1',
      repo: 'a/b',
      event_types: 'pull_request,issue_comment.created',
      wake: '0',
    });
    expect(JSON.parse(row.event_types_json)).toEqual(['pull_request', 'issue_comment.created']);
    expect(row.wake).toBe(0);
  });

  it('rejects malformed repo, bad number, and missing target', () => {
    expect(() => buildSubscriptionRow({ agent_group_id: 'ag-1', repo: 'nope' })).toThrow(/owner\/name/);
    expect(() => buildSubscriptionRow({ agent_group_id: 'ag-1', repo: 'a/b', number: -2 })).toThrow(/--number/);
    expect(() => buildSubscriptionRow({ repo: 'a/b' })).toThrow(/--agent-group-id/);
    expect(() => buildSubscriptionRow({ agent_group_id: 'ag-1', number: 5 })).toThrow(/--repo/);
  });
});

describe('subscriptions CLI resource', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = await initTestDb();
    await runMigrations(db);
    await createGroup('ag-1');
    await createGroup('ag-2');
  });

  it('agent self-serves a subscription for its own group', async () => {
    const res = await call(
      'subscriptions-create',
      { repo: 'cjfinnell/homelab', event_types: 'pull_request' },
      agentCtx(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data).toMatchObject({
      agent_group_id: 'ag-1',
      subject: 'github:repo:cjfinnell/homelab*',
      existing: false,
    });
  });

  it('is idempotent per (group, source, subject)', async () => {
    await call('subscriptions-create', { repo: 'cjfinnell/homelab' }, agentCtx());
    const again = await call('subscriptions-create', { repo: 'cjfinnell/homelab' }, agentCtx());
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect((again.data as { existing: boolean }).existing).toBe(true);
  });

  it('denies creating for another group', async () => {
    const res = await call(
      'subscriptions-create',
      { repo: 'cjfinnell/homelab', agent_group_id: 'ag-2' },
      agentCtx('ag-1'),
    );
    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('agent cannot delete another group subscription; owner can', async () => {
    const created = await call('subscriptions-create', { repo: 'cjfinnell/homelab' }, agentCtx('ag-2'));
    if (!created.ok) throw new Error('create failed');
    const id = (created.data as { id: string }).id;

    const foreign = await call('subscriptions-delete', { id }, agentCtx('ag-1'));
    expect(foreign).toMatchObject({ ok: false });

    const own = await call('subscriptions-delete', { id }, agentCtx('ag-2'));
    expect(own.ok).toBe(true);
  });

  it('host creates for any group; agent list is scoped to own rows', async () => {
    await call('subscriptions-create', { repo: 'cjfinnell/homelab', agent_group_id: 'ag-2' }, hostCtx);

    const agentView = await call('subscriptions-list', {}, agentCtx('ag-1'));
    expect(agentView.ok).toBe(true);
    if (agentView.ok) expect(agentView.data).toEqual([]);

    const hostView = await call('subscriptions-list', {}, hostCtx);
    expect(hostView.ok).toBe(true);
    if (hostView.ok) expect((hostView.data as unknown[]).length).toBe(1);
  });

  it('updates wake and pauses without deleting', async () => {
    const created = await call('subscriptions-create', { repo: 'cjfinnell/homelab' }, agentCtx());
    if (!created.ok) throw new Error('create failed');
    const id = (created.data as { id: string }).id;

    const updated = await call('subscriptions-update', { id, wake: '0', enabled: '0' }, agentCtx());
    expect(updated.ok).toBe(true);

    const list = await call('subscriptions-list', {}, agentCtx());
    if (!list.ok) throw new Error('list failed');
    const row = (list.data as { id: string; wake: number; enabled: number }[]).find((r) => r.id === id);
    expect(row).toMatchObject({ wake: 0, enabled: 0 });
  });
});
