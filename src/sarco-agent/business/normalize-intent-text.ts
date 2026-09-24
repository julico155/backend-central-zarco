/**
 * Normaliza texto para matching determinístico: trim, minúsculas, NFD sin
 * diacríticos, sin signos y espacios colapsados. Puerto directo de
 * sarcoRestaurant (src/lib/webhook/menu-intent.ts::normalizeIntentText) —
 * se porta solo esta función, no el resto del detector de intención de menú
 * (fuera de alcance de esta fase).
 */
export function normalizeIntentText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // elimina diacríticos/tildes (marcas combinantes)
    .toLowerCase()
    .replace(/[¿?¡!.,;:"'()]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
