/**
 * `ncl subscriptions` — self-serve webhook event subscriptions.
 *
 * Resource shape: subscriptions (central DB, migration 026). Agents in
 * group CLI scope create/list/update/delete rows pinned to their OWN agent
 * group (dispatch auto-fills agent_group_id; the guard denies cross-group
 * args) — the row's group is simultaneously the delivery target, so
 * self-serve can never route events to another group. Host callers may
 * pass --agent-group-id to manage any group's rows.
 *
 * All verbs are `open` (no approval card) per the recorded decision in
 * cjfinnell/homelab#86: creation rights = agent self-serve, target =
 * own group only, repos = whatever the source adapter can see.
 *
 * GitHub sugar: `--repo owner/name [--number N]` compiles to the generic
 * subject glob (`github:repo:owner/name*` / `github:repo:owner/name#N`);
 * `--subject` sets a raw subject for anything else (or other sources).
 * `--event-types` is a comma list (`pull_request` matches the family,
 * `pull_request.opened` the exact type).
 */
import { randomUUID } from 'node:crypto';

import {
  createSubscription,
  deleteSubscription,
  getSubscription,
  getSubscriptionByNaturalKey,
  getSubscriptionsByAgentGroup,
  listSubscriptions,
  updateSubscription,
} from '../../db/subscriptions.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import type { Subscription } from '../../types.js';
import { registerResource } from '../crud.js';
import type { CallerContext } from '../frame.js';

const SOURCES = ['github'] as const;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SUBJECT_RE = /^[a-z0-9][a-z0-9:_/#.*?-]*$/;

/** `7d`/`12h`/ISO — relative durations from now, or a raw ISO timestamp. */
export function parseExpires(raw: string, now = new Date()): string | null {
  if (raw === 'none' || raw === 'never') return null;
  const rel = /^(\d+)([d h])$/i.exec(raw.trim().replace(/\s+/, ''));
  if (rel) {
    const n = Number(rel[1]);
    const ms = rel[2].toLowerCase() === 'd' ? n * 86_400_000 : n * 3_600_000;
    return new Date(now.getTime() + ms).toISOString();
  }
  const iso = new Date(raw);
  if (!Number.isNaN(iso.getTime())) return iso.toISOString();
  throw new Error(`invalid --expires ${JSON.stringify(raw)}: use e.g. 7d, 12h, an ISO timestamp, or 'none'`);
}

function strarg(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = args[n];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function numarg(args: Record<string, unknown>, name: string): number | undefined {
  const v = args[name];
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
  return n;
}

function boolint(v: unknown, fallback: 0 | 1): 0 | 1 {
  if (v === undefined || v === null || v === '') return fallback;
  if (v === true || v === 1 || v === '1' || v === 'true') return 1;
  if (v === false || v === 0 || v === '0' || v === 'false') return 0;
  throw new Error(`expected a boolean, got ${JSON.stringify(v)}`);
}

/** Build the row every create path shares. Throws with actionable messages. */
export function buildSubscriptionRow(
  args: Record<string, unknown>,
  now = new Date(),
): Omit<Subscription, 'id' | 'created_at'> {
  const source = (strarg(args, 'source') ?? 'github').toLowerCase();
  if (!(SOURCES as readonly string[]).includes(source)) {
    throw new Error(`--source must be one of: ${SOURCES.join(', ')} (more adapters later)`);
  }
  const agentGroupId = strarg(args, 'agent_group_id', 'group', 'id');
  if (!agentGroupId) throw new Error('--agent-group-id is required');

  const repo = strarg(args, 'repo');
  const number = numarg(args, 'number');
  let subject = strarg(args, 'subject');
  if (!subject && repo) {
    if (!REPO_RE.test(repo)) throw new Error(`--repo must look like owner/name, got ${JSON.stringify(repo)}`);
    subject = number !== undefined ? `github:repo:${repo}#${number}` : `github:repo:${repo}*`;
  }
  if (!subject) {
    throw new Error('provide --repo owner/name (optionally --number N) or a raw --subject');
  }
  if (!SUBJECT_RE.test(subject)) {
    throw new Error(`--subject has invalid characters: ${JSON.stringify(subject)}`);
  }
  if (number !== undefined && !repo) {
    throw new Error('--number only applies together with --repo');
  }

  const rawTypes = strarg(args, 'event_types', 'event-types', 'events');
  const types = rawTypes
    ? rawTypes
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : [];

  const expiresRaw = strarg(args, 'expires');
  const expiresAt =
    expiresRaw !== undefined
      ? parseExpires(expiresRaw, now)
      : number !== undefined
        ? parseExpires('7d', now) // thread-pinned subscriptions lapse with the thread
        : null;

  return {
    agent_group_id: agentGroupId,
    source,
    subject,
    event_types_json: JSON.stringify(types),
    wake: boolint(args.wake, 1),
    enabled: boolint(args.enabled, 1),
    expires_at: expiresAt,
  };
}

/** Ownership check for by-id mutations: agent callers may only touch own rows. */
async function ownedSubscription(id: string, ctx: CallerContext): Promise<Subscription> {
  const row = await getSubscription(id);
  if (!row) throw new Error(`subscription not found: ${id}`);
  if (ctx.caller === 'agent' && row.agent_group_id !== ctx.agentGroupId) {
    throw new Error('Subscription belongs to a different agent group.');
  }
  return row;
}

registerResource({
  name: 'subscription',
  plural: 'subscriptions',
  table: 'subscriptions',
  description:
    'Event subscription — one rule: match webhook events from a source (subject glob + type filters) and deliver them to the owning agent group, waking it or accumulating as context. Self-serve: agents subscribe to repos, issues or PRs they want to hear about; events with no subscription are dropped.',
  idColumn: 'id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'id', type: 'string', description: 'Subscription id (sub-…).' },
    {
      name: 'agent_group_id',
      type: 'string',
      description: 'Owning agent group — also the delivery target. Auto-filled to the calling group for agents.',
    },
    {
      name: 'source',
      type: 'string',
      description: 'Event source. Filters and subjects are generic per source.',
      enum: [...SOURCES],
    },
    {
      name: 'subject',
      type: 'string',
      description:
        'Subject glob matched against the source thread key. GitHub repo level: github:repo:owner/name* — one thread: github:repo:owner/name#184.',
    },
    {
      name: 'event_types_json',
      type: 'string',
      description:
        'JSON array of type filters; empty = all. Family match: pull_request covers pull_request.opened etc.',
    },
    { name: 'wake', type: 'boolean', description: 'true = wake the target on match; false = accumulate as context.' },
    { name: 'enabled', type: 'boolean', description: 'Pause/resume without deleting.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
    { name: 'expires_at', type: 'string', description: 'ISO timestamp; null = never. Thread-pinned defaults to 7d.' },
  ],
  operations: { get: 'open' },
  listOrder: 'agent_group_id, created_at',
  customOperations: {
    create: {
      access: 'open',
      description:
        'Subscribe this agent to events. Sugar: --repo owner/name [--number N] [--event-types pull_request,issue_comment] [--wake 0|1] [--expires 7d|none]. Advanced: --subject <raw glob> [--source github]. Idempotent per (group, source, subject).',
      examples: [
        'ncl subscriptions create --repo cjfinnell/homelab --event-types pull_request,pull_request_review',
        'ncl subscriptions create --repo cjfinnell/homelab --number 184 --event-types issue_comment',
      ],
      handler: async (args) => {
        const row = buildSubscriptionRow(args);
        const agentGroup = await getAgentGroup(row.agent_group_id);
        if (!agentGroup) throw new Error(`agent group not found: ${row.agent_group_id}`);

        // Idempotent on the natural key — re-running a subscribe step is safe.
        const existing = await getSubscriptionByNaturalKey(
          row.agent_group_id,
          row.source,
          row.subject,
          row.event_types_json,
        );
        if (existing) {
          return {
            id: existing.id,
            agent_group_id: existing.agent_group_id,
            source: existing.source,
            subject: existing.subject,
            existing: true,
          };
        }
        const full: Subscription = {
          ...row,
          id: `sub-${randomUUID().slice(0, 8)}`,
          created_at: new Date().toISOString(),
        };
        await createSubscription(full);
        return { ...full, existing: false };
      },
    },
    update: {
      access: 'open',
      description: 'Change --wake, --enabled or --expires on a subscription. Use --id.',
      handler: async (args, ctx) => {
        const id = strarg(args, 'id');
        if (!id) throw new Error('--id is required');
        await ownedSubscription(id, ctx);
        const updates: { wake?: 0 | 1; enabled?: 0 | 1; expires_at?: string | null } = {};
        if (args.wake !== undefined) updates.wake = boolint(args.wake, 1);
        if (args.enabled !== undefined) updates.enabled = boolint(args.enabled, 1);
        if (strarg(args, 'expires') !== undefined) updates.expires_at = parseExpires(strarg(args, 'expires')!);
        if (Object.keys(updates).length === 0) {
          throw new Error('nothing to update: pass --wake, --enabled and/or --expires');
        }
        await updateSubscription(id, updates);
        return { id, ...updates };
      },
    },
    delete: {
      access: 'open',
      description: 'Delete a subscription. Use --id.',
      handler: async (args, ctx) => {
        const id = strarg(args, 'id');
        if (!id) throw new Error('--id is required');
        const row = await ownedSubscription(id, ctx);
        await deleteSubscription(id);
        return { id, deleted: true, subject: row.subject };
      },
    },
    list: {
      access: 'open',
      description: 'List subscriptions — own group for agents, all (or one via --agent-group-id) for the host.',
      handler: async (args, ctx) => {
        const group = strarg(args, 'agent_group_id', 'group');
        if (group) return getSubscriptionsByAgentGroup(group);
        if (ctx.caller === 'agent') return getSubscriptionsByAgentGroup(ctx.agentGroupId);
        return listSubscriptions();
      },
    },
  },
});
