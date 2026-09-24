/**
 * Desenlace de un envío saliente por Kapso. Puerto directo de sarcoRestaurant
 * (src/lib/kapso/send-outcome.ts, Fase 6D.2F.5A): distingue "consta que no
 * salió" (reintentable, se puede repetir sin duplicar) de "no hay certeza"
 * (nunca se reenvía a ciegas, porque el mensaje pudo llegar igual).
 */

export type KapsoSendOutcome = 'failed' | 'send_unknown';

export function classifyKapsoSendFailure(error: string, status?: number): KapsoSendOutcome {
  switch (error) {
    case 'invalid_phone':
    case 'invalid_text':
    case 'invalid_body_text':
    case 'invalid_image':
      return 'failed';
    case 'http_error':
      return status !== undefined && status < 500 ? 'failed' : 'send_unknown';
    default:
      return 'send_unknown';
  }
}
