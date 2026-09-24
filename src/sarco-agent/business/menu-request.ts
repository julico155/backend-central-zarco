import { normalizeIntentText } from './normalize-intent-text';

/**
 * ¿El cliente pidió el menú EN ESTE MENSAJE? Puerto directo de
 * sarcoRestaurant (src/lib/agent/business/menu-request.ts, Fase 6D.2F.5B).
 *
 * Sirve para el `reason` que `send_menu` registra en el ledger
 * (`explicit_request` vs `agent_suggestion`, Fase 2C): observabilidad, no
 * un permiso — las dos etiquetas mandan el mismo CTA.
 *
 * Alta confianza, tolerancia a typos limitada a dos transformaciones que no
 * pueden convertir otra palabra en "menu"/"carta": letras repetidas
 * ("mennu") y transposición contigua ("mneu").
 */

const MENU_NOUNS: readonly string[] = ['menu', 'carta'];

function isAdjacentTransposition(token: string, canonical: string): boolean {
  if (token.length !== canonical.length) return false;

  const diffs: number[] = [];
  for (let i = 0; i < token.length; i += 1) {
    if (token[i] !== canonical[i]) {
      diffs.push(i);
      if (diffs.length > 2) return false;
    }
  }
  if (diffs.length !== 2) return false;

  const [a, b] = diffs;
  return b === a + 1 && token[a] === canonical[b] && token[b] === canonical[a];
}

function candidateForms(token: string): string[] {
  const squeezed = token.replace(/(.)\1+/g, '$1');
  return squeezed.endsWith('s') ? [squeezed, squeezed.slice(0, -1)] : [squeezed];
}

/** `true` solo si el mensaje del cliente nombra el menú o la carta. */
export function isExplicitMenuRequest(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;

  const norm = normalizeIntentText(text);
  if (norm === '') return false;

  for (const token of norm.split(/[^a-z0-9]+/)) {
    if (token === '') continue;
    for (const form of candidateForms(token)) {
      for (const noun of MENU_NOUNS) {
        if (form === noun || isAdjacentTransposition(form, noun)) return true;
      }
    }
  }
  return false;
}
