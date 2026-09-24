import type { Kysely } from 'kysely';
import type { AgentDatabase } from '../../../src/database/agent-types';
import type { Database } from '../../../src/database/types';
import { E2E_PREFIX } from './options';
import type { Manifest } from './manifest';

/**
 * Registra en el manifest lo que la APLICACIÓN creó durante el E2E, siguiendo
 * únicamente las relaciones que nacen del teléfono E2E y de los ids ya
 * registrados. Solo SELECT. Se llama tras cada paso y, en el cleanup manual,
 * antes de borrar (por si Jest murió entre "la app creó" y "el test lo anotó").
 */
export async function discoverByIdentity(
  central: Kysely<Database>,
  agent: Kysely<AgentDatabase>,
  manifest: Manifest,
): Promise<void> {
  const { phone, runId } = manifest.data;

  // ── Agente ─────────────────────────────────────────────────────────────
  const conversations = await agent
    .selectFrom('agent_conversations')
    .select('id')
    .where('customer_phone', '=', phone)
    .execute();
  manifest.addAgent('agent_conversations', ...conversations.map((r) => r.id));
  const conversationIds = manifest.ids('agent', 'agent_conversations');

  if (conversationIds.length > 0) {
    manifest.addAgent(
      'agent_messages',
      ...(
        await agent
          .selectFrom('agent_messages')
          .select('id')
          .where('agent_conversation_id', 'in', conversationIds)
          .execute()
      ).map((r) => r.id),
    );
    manifest.addAgent(
      'agent_runs',
      ...(
        await agent
          .selectFrom('agent_runs')
          .select('id')
          .where('agent_conversation_id', 'in', conversationIds)
          .execute()
      ).map((r) => r.id),
    );
    manifest.addAgent(
      'agent_control_events',
      ...(
        await agent
          .selectFrom('agent_control_events')
          .select('id')
          .where('agent_conversation_id', 'in', conversationIds)
          .execute()
      ).map((r) => r.id),
    );
  }
  manifest.addAgent(
    'webhook_events',
    ...(
      await agent
        .selectFrom('webhook_events')
        .select('id')
        .where('event_id', 'like', `${E2E_PREFIX}${runId}-%`)
        .execute()
    ).map((r) => r.id),
  );
  manifest.addAgent(
    'menu_sessions',
    ...(
      await agent
        .selectFrom('menu_sessions')
        .select('id')
        .where('customer_phone', '=', phone)
        .execute()
    ).map((r) => r.id),
  );
  manifest.addAgent(
    'menu_send_deliveries',
    ...(
      await agent
        .selectFrom('menu_send_deliveries')
        .select('id')
        .where('customer_phone', '=', phone)
        .execute()
    ).map((r) => r.id),
  );

  // ── Central ────────────────────────────────────────────────────────────
  manifest.addCentral(
    'customers',
    ...(
      await central.selectFrom('customers').select('id').where('phone', '=', phone).execute()
    ).map((r) => r.id),
  );
  const customerIds = manifest.ids('central', 'customers');

  if (customerIds.length > 0) {
    manifest.addCentral(
      'orders',
      ...(
        await central
          .selectFrom('orders')
          .select('id')
          .where('customer_id', 'in', customerIds)
          .execute()
      ).map((r) => r.id),
    );
  }
  const orderIds = manifest.ids('central', 'orders');

  if (orderIds.length > 0) {
    manifest.addCentral(
      'order_items',
      ...(
        await central
          .selectFrom('order_items')
          .select('id')
          .where('order_id', 'in', orderIds)
          .execute()
      ).map((r) => r.id),
    );
    manifest.addCentral(
      'order_promotions',
      ...(
        await central
          .selectFrom('order_promotions')
          .select('id')
          .where('order_id', 'in', orderIds)
          .execute()
      ).map((r) => r.id),
    );
    manifest.addCentral(
      'payment_attempts',
      ...(
        await central
          .selectFrom('payment_attempts')
          .select('id')
          .where('order_id', 'in', orderIds)
          .execute()
      ).map((r) => r.id),
    );
    manifest.addCentral(
      'bank_qr_charges',
      ...(
        await central
          .selectFrom('bank_qr_charges')
          .select('id')
          .where('order_id', 'in', orderIds)
          .execute()
      ).map((r) => r.id),
    );
  }

  const refs = [...orderIds, ...manifest.ids('central', 'payment_attempts'), ...customerIds];
  if (refs.length > 0) {
    manifest.addCentral(
      'notification_jobs',
      ...(
        await central
          .selectFrom('notification_jobs')
          .select('id')
          .where('target_ref', 'in', refs)
          .execute()
      ).map((r) => r.id),
    );
  }

  // La creación del pedido usa el id de la sesión de menú como Idempotency-Key.
  const sessionIds = manifest.ids('agent', 'menu_sessions');
  if (sessionIds.length > 0) {
    manifest.addCentral(
      'idempotency_keys',
      ...(
        await central
          .selectFrom('idempotency_keys')
          .select('id')
          .where('api_client', '=', 'whatsapp-gateway')
          .where('idempotency_key', 'in', sessionIds)
          .execute()
      ).map((r) => r.id),
    );
  }
}
