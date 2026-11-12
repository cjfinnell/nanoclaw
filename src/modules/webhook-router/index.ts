/**
 * Webhook-router module — route verified webhook events to subscribed agents.
 *
 * Registers the GitHub adapter's raw handler at /webhook/github on the
 * shared webhook server (src/webhook-server.ts) via registerWebhookHandler
 * — no second port, no edits to the server file. Registration is gated on
 * the secret being configured: without WEBHOOK_GITHUB_SECRET the module is
 * inert (no route, one warn line) so a checkout without ingress doesn't
 * open a signature-check-less endpoint.
 *
 * Flow per request: verify HMAC-SHA256 (x-hub-signature-256) → normalize
 * to the generic envelope (source, type, subject, payload) → dedupe on
 * X-GitHub-Delivery → match subscriptions (source + subject glob + type
 * filters) → deliver to each target group's agent-shared session, waking
 * per the subscription's flag. Events with no subscription are dropped —
 * the drop is the allowlist (cjfinnell/homelab#86).
 */
import { registerWebhookHandler } from '../../webhook-server.js';
import { getGitHubWebhookSecret } from '../../config.js';
import { log } from '../../log.js';
import { handleGithubRequest } from './adapters/github.js';
import { claimDeliveryId } from './dedupe.js';
import { deliverEvent } from './deliver.js';
import type { WebhookEvent } from './event.js';

const secret = getGitHubWebhookSecret();

if (secret) {
  registerWebhookHandler('github', (req, res) =>
    handleGithubRequest(req, res, {
      secret,
      onEvent: async (event: WebhookEvent) => {
        if (event.deliveryId && !claimDeliveryId(event.deliveryId)) {
          log.info('github webhook: duplicate delivery ignored', { deliveryId: event.deliveryId });
          return { status: 200, json: { ok: true, reason: 'duplicate delivery' } };
        }
        const outcome = await deliverEvent(event);
        return {
          status: 200,
          json: {
            ok: true,
            matched: outcome.matched,
            delivered: outcome.delivered,
            ...(outcome.droppedNoSubscription ? { reason: 'no subscription' } : {}),
          },
        };
      },
    }),
  );
} else {
  log.warn('webhook-router: WEBHOOK_GITHUB_SECRET not set — /webhook/github not registered');
}
