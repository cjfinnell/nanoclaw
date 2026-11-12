import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

/**
 * Event subscriptions: self-serve webhook routing rules.
 *
 * A row means: deliver events from `source` whose subject glob and type
 * filters match to the owning agent group, waking it or accumulating as
 * context. The owning agent_group_id is the delivery target — agents
 * subscribe themselves (group-scoped CLI), which keeps the table both the
 * routing rule and the allowlist: no row, no delivery.
 *
 * Source-agnostic by design — see the Subscription type comment. The
 * subject is the source's generic thread key, stored as a glob so one row
 * can cover a repo and all its threads (`github:repo:owner/name*`).
 */
export const migration026: Migration = {
  version: 26,
  name: 'subscriptions',
  sqliteOnly: true,
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE subscriptions (
        id               TEXT PRIMARY KEY,
        agent_group_id   TEXT NOT NULL REFERENCES agent_groups(id),
        source           TEXT NOT NULL,
        subject          TEXT NOT NULL,
        event_types_json TEXT NOT NULL DEFAULT '[]',
        wake             INTEGER NOT NULL DEFAULT 1,
        enabled          INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL,
        expires_at       TEXT,
        UNIQUE (agent_group_id, source, subject)
      );
      CREATE INDEX idx_subscriptions_source ON subscriptions(source, enabled);
    `);
  },
};
