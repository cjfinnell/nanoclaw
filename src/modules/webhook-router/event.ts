/**
 * The generic webhook event envelope.
 *
 * Every source normalizes to this shape before any subscription logic runs
 * (design: cjfinnell/homelab#86 — the abstractions must not couple to any
 * one provider). Adapters own all source-specific knowledge; the matcher
 * and the delivery path are source-blind.
 *
 *   source   'github' | 'email' | 'rss' | …
 *   type     the full dotted type: event plus action when the source has
 *            one ('pull_request.opened'), else the bare event ('ping').
 *            Dotted types let a filter match the exact type or the family.
 *   subject  the source-agnostic thread key: 'github:repo:owner/name',
 *            'github:repo:owner/name#184' — later 'email:thread:<id>',
 *            'rss:feed:<id>'. Subscriptions glob-match this key.
 *   payload  the verified raw body, parsed. Opaque to the router; the
 *            renderer picks what to show.
 */
export interface WebhookEvent {
  source: string;
  type: string;
  subject: string;
  payload: Record<string, unknown>;
  /** Sender login/name when the source carries one — display only. */
  sender?: string;
  /** Stable event id from the source (X-GitHub-Delivery); dedupe key. */
  deliveryId?: string;
}
