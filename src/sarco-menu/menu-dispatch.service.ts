import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { KapsoOutboundService } from '../kapso/kapso-outbound.service';
import { classifyKapsoSendFailure } from '../kapso/kapso-send-outcome';
import type { DispatchMenuResult, MenuDispatchPort } from '../sarco-agent/tools/menu-tools';
import { MenuSendDeliveryRepository } from './menu-send-delivery.repository';
import { MenuSessionRepository } from './menu-session.repository';
import { generateMenuSessionToken, hashMenuSessionToken } from './menu-session-token';
import { MENU_CTA_BUTTON_TEXT, menuCtaBodyText } from './menu-cta-copy';

const logger = new Logger('MenuDispatchService');

/** No se reenvía el mismo CTA a un cliente que acaba de recibirlo. */
const ECHO_WINDOW_MS = 30_000;

/**
 * Implementación real de `MenuDispatchPort` (declarado en
 * `sarco-agent/tools/menu-tools.ts`, Fase 2B). Puerto directo de
 * sarcoRestaurant (src/lib/menu/dispatch.ts + send-menu-cta.ts):
 *
 *   1. crea o reutiliza una `menu_session` válida (sin efecto visible);
 *   2. reclama el envío en `menu_send_deliveries` por WAMID (ON CONFLICT DO
 *      NOTHING) — ANTES de tocar Kapso, así una reentrega nunca reenvía;
 *   3. ventana de eco: si este teléfono recibió un CTA hace menos de 30 s,
 *      se marca `blocked_recent` sin llamar a Kapso;
 *   4. envía el `cta_url` por Kapso directo (`KapsoOutboundService`);
 *   5. cierra el ledger con el desenlace real.
 */
@Injectable()
export class MenuDispatchService implements MenuDispatchPort {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly sessions: MenuSessionRepository,
    private readonly deliveries: MenuSendDeliveryRepository,
    private readonly kapso: KapsoOutboundService,
  ) {}

  async dispatch(input: {
    customerPhone: string;
    sourceMessageId: string;
    phoneNumberId: string | null;
    reason: 'explicit_request' | 'agent_suggestion';
    replacesOrderId?: string | null;
    buttonText?: string;
    bodyText?: string;
  }): Promise<DispatchMenuResult> {
    const menu = this.config.get('menu', { infer: true });
    const replacesOrderId = input.replacesOrderId ?? null;
    const phoneNumberId = input.phoneNumberId ?? '';

    const session = await this.resolveSession(input, phoneNumberId, replacesOrderId);
    if (session === null) return { result: 'failed' };

    const claim = await this.deliveries.claim(
      input.sourceMessageId,
      input.customerPhone,
      input.reason,
    );
    if (!claim.claimed) return { result: 'duplicate' };

    const lastSentAt = await this.deliveries.lastSentAt(input.customerPhone);
    if (lastSentAt !== null && Date.now() - Date.parse(lastSentAt) < ECHO_WINDOW_MS) {
      await this.deliveries.finish({ id: claim.id, status: 'blocked_recent' });
      return { result: 'echo' };
    }

    const menuUrl = `${menu.webBaseUrl}/menu?session=${encodeURIComponent(session.token)}`;
    const sent = await this.kapso.sendMenuCtaUrl({
      customerPhone: input.customerPhone,
      phoneNumberId: input.phoneNumberId,
      menuUrl,
      coverImageUrl: menu.coverImageUrl,
      bodyText: input.bodyText ?? menuCtaBodyText(input.reason),
      buttonText: input.buttonText ?? MENU_CTA_BUTTON_TEXT,
    });

    if (sent.ok) {
      await this.deliveries.finish({ id: claim.id, status: 'sent', providerMessageId: sent.wamid });
      return { result: 'sent' };
    }

    const status = classifyKapsoSendFailure(sent.error, sent.status);
    await this.deliveries.finish({ id: claim.id, status, errorCode: `send.${sent.error}` });
    logger.warn(`menu_cta_send_failed error=${sent.error} status=${status}`);
    return { result: status };
  }

  /**
   * Reutiliza la sesión vigente de este teléfono (si no es un enlace de
   * reemplazo), o crea una nueva a partir del WAMID que disparó este envío.
   * `null` = el token/secreto no está configurado: no se puede continuar.
   */
  private async resolveSession(
    input: { customerPhone: string; sourceMessageId: string },
    phoneNumberId: string,
    replacesOrderId: string | null,
  ): Promise<{ id: string; token: string } | null> {
    const secret = this.config.get('menu', { infer: true }).sessionSecret;
    if (!secret) {
      logger.warn('menu_session_secret_not_configured');
      return null;
    }

    if (replacesOrderId === null) {
      const existing = await this.sessions.findValidByPhone(input.customerPhone);
      if (existing !== null) {
        const token = generateMenuSessionToken(existing.sourceMessageId, secret);
        if (hashMenuSessionToken(token) === existing.tokenHash) {
          await this.sessions.renewExpiry(existing.id);
          return { id: existing.id, token };
        }
        // El hash guardado no coincide con lo que el secreto actual
        // regenera (p. ej. rotación de MENU_SESSION_SECRET): no se reutiliza
        // esta fila corrupta, se crea una nueva desde el WAMID de ahora.
        logger.warn('menu_session_hash_mismatch_on_reuse');
      }
    }

    const token = generateMenuSessionToken(input.sourceMessageId, secret);
    const tokenHash = hashMenuSessionToken(token);
    const session = await this.sessions.getOrCreate({
      sourceMessageId: input.sourceMessageId,
      tokenHash,
      customerPhone: input.customerPhone,
      phoneNumberId,
      replacesOrderId,
    });
    return { id: session.id, token };
  }
}
