import type { Kysely } from 'kysely';
import type { AgentDatabase } from '../../../src/database/agent-types';
import type { Database } from '../../../src/database/types';
import { E2E_PREFIX } from './options';
import type { AgentTable, CentralTable, Manifest } from './manifest';

export interface CleanupReport {
  /** `db.tabla` → filas borradas. */
  deleted: Record<string, number>;
  /** `db.tabla` → ids registrados que ya no existían (idempotencia del cleanup). */
  alreadyGone: Record<string, number>;
}

export class CleanupSafetyError extends Error {
  constructor(message: string) {
    super(`Cleanup abortado: ${message}`);
    this.name = 'CleanupSafetyError';
  }
}

const WHATSAPP_API_CLIENT = 'whatsapp-gateway';
/** Id nulo válido para uuid: mantiene el `in (...)` bien formado cuando la lista está vacía (no coincide con nada). */
const NIL = '00000000-0000-0000-0000-000000000000';

/** Cada DELETE borra como MÁXIMO los ids registrados: si borra más, se aborta y se revierte. */
function checked(
  label: string,
  ids: string[],
  deleted: bigint | undefined,
  report: CleanupReport,
): void {
  const n = Number(deleted ?? 0n);
  if (n > ids.length) {
    throw new CleanupSafetyError(
      `${label} habría borrado ${n} filas y solo hay ${ids.length} ids registrados.`,
    );
  }
  report.deleted[label] = n;
  report.alreadyGone[label] = ids.length - n;
}

/**
 * Borra EXCLUSIVAMENTE los ids del manifest. Nunca hay un DELETE sin
 * `id in (<ids registrados>)`, y cada uno añade además una condición que prueba
 * el origen E2E (cliente/teléfono E2E, prefijo `e2e-`, pedido registrado…).
 * Cada base se borra dentro de UNA transacción: si cualquier paso falla, no se
 * borra nada de esa base.
 */
export async function cleanupFromManifest(
  central: Kysely<Database>,
  agent: Kysely<AgentDatabase>,
  manifest: Manifest,
): Promise<CleanupReport> {
  const report: CleanupReport = { deleted: {}, alreadyGone: {} };
  const phone = manifest.data.phone;
  const c = (t: CentralTable) => manifest.ids('central', t);
  const a = (t: AgentTable) => manifest.ids('agent', t);

  // ── Central: hijos antes que padres ────────────────────────────────────
  await central.transaction().execute(async (trx) => {
    const orderIds = c('orders');
    const attemptIds = c('payment_attempts');
    const customerIds = c('customers');
    const refs = [...orderIds, ...attemptIds, ...customerIds];

    let ids = c('notification_jobs');
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('notification_jobs')
        .where('id', 'in', ids)
        .where('target_ref', 'in', refs.length > 0 ? refs : [NIL])
        .executeTakeFirst();
      checked('central.notification_jobs', ids, r?.numDeletedRows, report);
    }

    ids = c('bank_qr_charges');
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('bank_qr_charges')
        .where('id', 'in', ids)
        .where('order_id', 'in', orderIds.length > 0 ? orderIds : [NIL])
        .executeTakeFirst();
      checked('central.bank_qr_charges', ids, r?.numDeletedRows, report);
    }

    ids = c('payment_attempts');
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('payment_attempts')
        .where('id', 'in', ids)
        .where('order_id', 'in', orderIds.length > 0 ? orderIds : [NIL])
        .executeTakeFirst();
      checked('central.payment_attempts', ids, r?.numDeletedRows, report);
    }

    ids = c('order_items');
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('order_items')
        .where('id', 'in', ids)
        .where('order_id', 'in', orderIds.length > 0 ? orderIds : [NIL])
        .executeTakeFirst();
      checked('central.order_items', ids, r?.numDeletedRows, report);
    }

    ids = c('order_promotions');
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('order_promotions')
        .where('id', 'in', ids)
        .where('order_id', 'in', orderIds.length > 0 ? orderIds : [NIL])
        .executeTakeFirst();
      checked('central.order_promotions', ids, r?.numDeletedRows, report);
    }

    ids = c('orders');
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('orders')
        .where('id', 'in', ids)
        .where('customer_id', 'in', customerIds.length > 0 ? customerIds : [NIL])
        .executeTakeFirst();
      checked('central.orders', ids, r?.numDeletedRows, report);
    }

    ids = c('idempotency_keys');
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('idempotency_keys')
        .where('id', 'in', ids)
        .where('api_client', '=', WHATSAPP_API_CLIENT)
        .executeTakeFirst();
      checked('central.idempotency_keys', ids, r?.numDeletedRows, report);
    }

    ids = customerIds;
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('customers')
        .where('id', 'in', ids)
        .where('phone', '=', phone)
        .executeTakeFirst();
      checked('central.customers', ids, r?.numDeletedRows, report);
    }

    ids = c('products');
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('products')
        .where('id', 'in', ids)
        .where('code', 'like', `${E2E_PREFIX}%`)
        .executeTakeFirst();
      checked('central.products', ids, r?.numDeletedRows, report);
    }

    ids = c('categories');
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('categories')
        .where('id', 'in', ids)
        .where('name', 'like', `${E2E_PREFIX}%`)
        .executeTakeFirst();
      checked('central.categories', ids, r?.numDeletedRows, report);
    }

    ids = c('cash_register_sessions');
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('cash_register_sessions')
        .where('id', 'in', ids)
        .where('opened_by', 'like', `${E2E_PREFIX}%`)
        .executeTakeFirst();
      checked('central.cash_register_sessions', ids, r?.numDeletedRows, report);
    }
  });

  // ── Agente ─────────────────────────────────────────────────────────────
  await agent.transaction().execute(async (trx) => {
    const convIds = a('agent_conversations');
    const guard = convIds.length > 0 ? convIds : [NIL];

    let ids = a('agent_runs');
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('agent_runs')
        .where('id', 'in', ids)
        .where('agent_conversation_id', 'in', guard)
        .executeTakeFirst();
      checked('agent.agent_runs', ids, r?.numDeletedRows, report);
    }

    ids = a('agent_control_events');
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('agent_control_events')
        .where('id', 'in', ids)
        .where('agent_conversation_id', 'in', guard)
        .executeTakeFirst();
      checked('agent.agent_control_events', ids, r?.numDeletedRows, report);
    }

    ids = a('agent_messages');
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('agent_messages')
        .where('id', 'in', ids)
        .where('agent_conversation_id', 'in', guard)
        .executeTakeFirst();
      checked('agent.agent_messages', ids, r?.numDeletedRows, report);
    }

    ids = convIds;
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('agent_conversations')
        .where('id', 'in', ids)
        .where('customer_phone', '=', phone)
        .executeTakeFirst();
      checked('agent.agent_conversations', ids, r?.numDeletedRows, report);
    }

    ids = a('webhook_events');
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('webhook_events')
        .where('id', 'in', ids)
        .where('event_id', 'like', `${E2E_PREFIX}%`)
        .executeTakeFirst();
      checked('agent.webhook_events', ids, r?.numDeletedRows, report);
    }

    ids = a('menu_sessions');
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('menu_sessions')
        .where('id', 'in', ids)
        .where('customer_phone', '=', phone)
        .executeTakeFirst();
      checked('agent.menu_sessions', ids, r?.numDeletedRows, report);
    }

    ids = a('menu_send_deliveries');
    if (ids.length > 0) {
      const r = await trx
        .deleteFrom('menu_send_deliveries')
        .where('id', 'in', ids)
        .where('customer_phone', '=', phone)
        .executeTakeFirst();
      checked('agent.menu_send_deliveries', ids, r?.numDeletedRows, report);
    }
  });

  return report;
}
