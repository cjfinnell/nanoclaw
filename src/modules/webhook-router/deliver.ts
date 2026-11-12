/**
 * Match an envelope against subscriptions and deliver to each target.
 *
 * Delivery reuses the agent-to-agent seam (the a2a module is the precedent
 * for writing into a group outside any messaging group): resolve the
 * target's agent-shared session, write one inbound message, wake it when
 * the subscription says wake. `trigger: false` rows are context-only —
 * the host's due-message gate does not wake on them, so `accumulate`
 * subscriptions stay silent until something else triggers the session.
 *
 * No subscription rows ⇒ nothing happens. That drop IS the allowlist: the
 * GitHub App install stays broad and events nobody subscribed to die here.
 */
import { matchSubscriptions } from '../../db/subscriptions.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { getSession } from '../../db/sessions.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { Subscription } from '../../types.js';
import { renderChatContent } from './render.js';
import type { WebhookEvent } from './event.js';

export interface DeliveryOutcome {
  matched: number;
  delivered: number;
  droppedNoSubscription: boolean;
}

export async function deliverEvent(event: WebhookEvent): Promise<DeliveryOutcome> {
  const subs = await matchSubscriptions(event.source, event.subject, event.type);
  if (subs.length === 0) {
    log.debug('webhook event matched no subscription — dropped', {
      source: event.source,
      subject: event.subject,
      type: event.type,
    });
    return { matched: 0, delivered: 0, droppedNoSubscription: true };
  }

  let delivered = 0;
  for (const sub of subs) {
    try {
      await deliverToSubscription(event, sub);
      delivered++;
    } catch (err) {
      // One bad target must not block the others; the redelivery story is
      // GitHub's own redeliver plus the operator reading the log.
      log.error('webhook delivery failed', {
        subscriptionId: sub.id,
        agentGroupId: sub.agent_group_id,
        subject: event.subject,
        err,
      });
    }
  }
  return { matched: subs.length, delivered, droppedNoSubscription: false };
}

async function deliverToSubscription(event: WebhookEvent, sub: Subscription): Promise<void> {
  const { session } = await resolveSession(sub.agent_group_id, null, null, 'agent-shared');
  const messageId = `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeSessionMessage(sub.agent_group_id, session.id, {
    id: messageId,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: `webhook:${event.source}`,
    channelType: 'webhook',
    threadId: null,
    content: renderChatContent(event),
    trigger: sub.wake === 1,
  });
  log.info('webhook event delivered', {
    subscriptionId: sub.id,
    agentGroupId: sub.agent_group_id,
    targetSession: session.id,
    wake: sub.wake === 1,
    subject: event.subject,
    type: event.type,
  });
  if (sub.wake === 1) {
    const fresh = await getSession(session.id);
    if (fresh) await requestWake(fresh, 'webhook');
  }
}
