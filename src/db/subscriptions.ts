/**
 * Event subscription persistence + matching (central DB).
 *
 * Rows are created self-serve by agents (`ncl subscriptions create`, scoped
 * to their own group) or by the host operator. The webhook router reads them
 * live on every inbound event — no cache to invalidate; subscriptions take
 * effect on the next delivered webhook.
 */
import { getDb } from './connection.js';
import type { Subscription } from '../types.js';

export async function createSubscription(row: Subscription): Promise<void> {
  await getDb().run(
    `INSERT INTO subscriptions (id, agent_group_id, source, subject, event_types_json, wake, enabled, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.agent_group_id,
    row.source,
    row.subject,
    row.event_types_json,
    row.wake,
    row.enabled,
    row.created_at,
    row.expires_at,
  );
}

export async function getSubscription(id: string): Promise<Subscription | undefined> {
  return getDb().get<Subscription>('SELECT * FROM subscriptions WHERE id = ?', id);
}

export async function getSubscriptionByNaturalKey(
  agentGroupId: string,
  source: string,
  subject: string,
  eventTypesJson: string,
): Promise<Subscription | undefined> {
  return getDb().get<Subscription>(
    'SELECT * FROM subscriptions WHERE agent_group_id = ? AND source = ? AND subject = ? AND event_types_json = ?',
    agentGroupId,
    source,
    subject,
    eventTypesJson,
  );
}

export async function getSubscriptionsByAgentGroup(agentGroupId: string): Promise<Subscription[]> {
  return getDb().all<Subscription>(
    'SELECT * FROM subscriptions WHERE agent_group_id = ? ORDER BY created_at',
    agentGroupId,
  );
}

export async function listSubscriptions(): Promise<Subscription[]> {
  return getDb().all<Subscription>('SELECT * FROM subscriptions ORDER BY agent_group_id, created_at');
}

export async function updateSubscription(
  id: string,
  updates: Partial<Pick<Subscription, 'wake' | 'enabled' | 'expires_at'>>,
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (updates.wake !== undefined) {
    sets.push('wake = ?');
    params.push(updates.wake);
  }
  if (updates.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(updates.enabled);
  }
  if (updates.expires_at !== undefined) {
    sets.push('expires_at = ?');
    params.push(updates.expires_at);
  }
  if (sets.length === 0) return;
  params.push(id);
  await getDb().run(`UPDATE subscriptions SET ${sets.join(', ')} WHERE id = ?`, ...params);
}

export async function deleteSubscription(id: string): Promise<void> {
  await getDb().run('DELETE FROM subscriptions WHERE id = ?', id);
}

// ── Matching ──

/** Glob → RegExp. Supports only `*` (any run) and `?` (one char); everything else is literal. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function parseEventTypes(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function expiresBefore(sub: Subscription, now: string): boolean {
  return sub.expires_at !== null && sub.expires_at <= now;
}

function typeMatches(subTypes: string[], type: string): boolean {
  if (subTypes.length === 0) return true;
  return subTypes.some((t) => t === type || type.startsWith(`${t}.`));
}

/**
 * All enabled, unexpired subscriptions for `source` whose subject glob
 * matches `subject` and whose type filters match `type` (an entry matches
 * the exact type `pull_request.opened` or the whole family `pull_request`).
 */
export async function matchSubscriptions(source: string, subject: string, type: string): Promise<Subscription[]> {
  const now = new Date().toISOString();
  const rows = await getDb().all<Subscription>('SELECT * FROM subscriptions WHERE source = ? AND enabled = 1', source);
  return rows.filter(
    (sub) =>
      !expiresBefore(sub, now) &&
      globToRegExp(sub.subject).test(subject) &&
      typeMatches(parseEventTypes(sub.event_types_json), type),
  );
}
