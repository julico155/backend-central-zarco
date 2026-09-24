import { normalizeIntentText } from '../business/normalize-intent-text';

/**
 * Lo que de verdad necesita una persona. Puerto directo de sarcoRestaurant
 * (src/lib/agent/handoff/problem-signal.ts, 04-09-2026): dinero mal cobrado,
 * pedido en mal estado, o una queja/enfado dicho con todas las letras.
 */

const PROBLEMA_DE_DINERO =
  /(^|\s)(estafa|estafas|estafado|estafada|estafaron|estafador|estafadores|fraude|robo|robaron|robaste|ladron|ladrones|reembolso|devolucion|devolver|devuelvan|devuelvame|descontaron|cobraron|cobrado|cobraste|sobrecobro)(\s|$)|cobro de mas|cobraron de mas|me cobro de mas|pague de mas|pague dos veces|pague doble|doble cobro|dos veces el pago|mi plata|mi dinero|no me devolvieron/;

const PROBLEMA_CON_EL_PEDIDO =
  /(^|\s)(frio|fria|crudo|cruda|podrido|podrida|malogrado|malograda|vencido|vencida)(\s|$)|no me llego|no me llega|no llego mi pedido|no llego nada|no llega nada|no me ha llegado|no ha llegado|nunca llego|no me llegaron|mal estado|esta en mal estado|no es lo que pedi|no era lo que pedi|se equivocaron|pedido equivocado|falta la mitad|vino incompleto|llego incompleto/;

const QUEJA_O_ENFADO =
  /(^|\s)(reclamo|reclamar|queja|quejarme|denuncia|denunciar|denuncio|pesimo|pesima|horrible|malisimo|malisima|verguenza|indignante|inaceptable|asco|basura|porqueria)(\s|$)|no sirve|nadie me responde|no me responden|nadie contesta|no me contestan|nadie me atiende|voy a denunciar/;

/** ¿Este mensaje trae algo que solo una persona puede resolver? */
export function hasProblemSignal(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;

  const norm = normalizeIntentText(text);
  if (norm === '') return false;

  return (
    PROBLEMA_DE_DINERO.test(norm) || PROBLEMA_CON_EL_PEDIDO.test(norm) || QUEJA_O_ENFADO.test(norm)
  );
}
