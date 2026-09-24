/**
 * La cuenta que DEBE aparecer en un comprobante. Puerto directo de
 * sarcoRestaurant (src/lib/payment-proof/expected-account.ts). Módulo PURO.
 *
 * Es el patrón contra el que se contrasta lo que se lee en la imagen: si el
 * dinero no fue a esta cuenta, no fue al negocio. Todo sale de configuración
 * (`AppConfig.paymentProof`), nunca de la base ni del navegador.
 *
 * La comparación es TOLERANTE al formato (cada banco pinta lo mismo
 * distinto) pero ESTRICTA en lo que distingue: dígitos finales de la cuenta,
 * palabras significativas del nombre. `unknown` (no `mismatch`) es la
 * respuesta cuando el dato no se pudo leer o no está configurado — tratar
 * "no lo sé" como "no coincide" convertiría cada foto borrosa en acusación.
 */

export type FieldMatch = 'match' | 'mismatch' | 'unknown';

export interface ExpectedAccount {
  /** Basta con que UNA coincida. */
  bankNames: string[];
  /** Cuentas destino válidas, comparadas por sus dígitos finales. Basta con que UNA coincida. */
  accountNumbers: string[];
  /** Nombres válidos del titular. Basta con que UNO coincida. */
  holderNames: string[];
}

/** Cuántos dígitos finales bastan para reconocer la cuenta enmascarada. */
export const ACCOUNT_TAIL_DIGITS = 4;

const MASKED_MIN_VISIBLE_DIGITS = 4;

/** Lo que un banco usa para tapar dígitos: `78***705`, `784**705`, `78xx705`. */
const MASK_CHARS = /[*xX•·]/;

/** Deja solo los dígitos: fuera guiones, espacios, puntos y asteriscos. */
export function digitsOf(value: string | null | undefined): string {
  return (value ?? '').replace(/\D+/g, '');
}

/** `JUAN PÉREZ-GARCÍA` y `juan perez garcia` son el mismo nombre escrito por dos bancos distintos. */
export function normalizeName(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9ÑÜ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Palabras de una o dos letras se descartan: no distinguen a nadie. */
function significantTokens(name: string): string[] {
  return normalizeName(name)
    .split(' ')
    .filter((t) => t.length > 2);
}

function matchesOneAccount(read: string | null, expected: string | null): FieldMatch {
  const leido = digitsOf(read);
  const esperado = digitsOf(expected);
  if (!leido || !esperado) return 'unknown';
  if (leido === esperado) return 'match';

  if (MASK_CHARS.test(read ?? '')) {
    return matchesMaskedAccount(read ?? '', esperado);
  }

  if (leido.length < ACCOUNT_TAIL_DIGITS || esperado.length < ACCOUNT_TAIL_DIGITS) {
    return 'unknown';
  }

  if (leido.includes(esperado) || esperado.includes(leido)) return 'match';
  const cola = (v: string) => v.slice(-ACCOUNT_TAIL_DIGITS);
  return cola(leido) === cola(esperado) ? 'match' : 'mismatch';
}

/** `78***705` contra `78486705`: empieza por `78`, termina en `705`. Coincide. */
function matchesMaskedAccount(read: string, esperado: string): FieldMatch {
  const partes = read.split(new RegExp(`${MASK_CHARS.source}+`));
  const cabeza = digitsOf(partes[0]);
  const cola = digitsOf(partes[partes.length - 1]);

  if (cabeza.length + cola.length < MASKED_MIN_VISIBLE_DIGITS) return 'unknown';
  if (esperado.length < cabeza.length + cola.length) return 'mismatch';

  const empieza = cabeza === '' || esperado.startsWith(cabeza);
  const termina = cola === '' || esperado.endsWith(cola);
  return empieza && termina ? 'match' : 'mismatch';
}

export function matchesAccount(read: string | null, expected: string[]): FieldMatch {
  let huboComparacion = false;
  for (const cuenta of expected) {
    const veredicto = matchesOneAccount(read, cuenta);
    if (veredicto === 'match') return 'match';
    if (veredicto === 'mismatch') huboComparacion = true;
  }
  return huboComparacion ? 'mismatch' : 'unknown';
}

/** Casi todos se llaman "Banco algo": estas palabras no distinguen a ninguno. */
const PALABRAS_GENERICAS_DE_BANCO = new Set([
  'BANCO',
  'BANCA',
  'BANK',
  'MOVIL',
  'BOLIVIA',
  'BOLIVIANO',
  'SA',
  'SRL',
  'LTDA',
]);

function bankTokens(name: string): string[] {
  return significantTokens(name).filter((t) => !PALABRAS_GENERICAS_DE_BANCO.has(t));
}

export function matchesBank(read: string | null, expected: string[]): FieldMatch {
  const leidos = bankTokens(read ?? '');
  const candidatos = expected.map(bankTokens).filter((t) => t.length > 0);
  if (leidos.length === 0 || candidatos.length === 0) return 'unknown';

  for (const esperados of candidatos) {
    const [corto, largo] =
      leidos.length <= esperados.length ? [leidos, esperados] : [esperados, leidos];
    if (corto.every((t) => largo.includes(t))) return 'match';
  }
  return 'mismatch';
}

export function matchesHolder(read: string | null, expected: string[]): FieldMatch {
  const leidos = significantTokens(read ?? '');
  const candidatos = expected.map(significantTokens).filter((t) => t.length > 0);
  if (leidos.length === 0 || candidatos.length === 0) return 'unknown';

  for (const esperados of candidatos) {
    const [corto, largo] =
      leidos.length <= esperados.length ? [leidos, esperados] : [esperados, leidos];
    if (corto.every((t) => largo.includes(t))) return 'match';
  }
  return 'mismatch';
}

/** Lee la cuenta esperada de la configuración. `null` = nada configurado, el análisis no puede contrastar nada. */
export function parseExpectedAccount(raw: {
  bank?: string | null;
  bankAliases?: string | null;
  accountNumbers?: string | null;
  holder?: string | null;
  holderAliases?: string | null;
}): ExpectedAccount | null {
  const separadas = (v: string | null | undefined, primera?: string | null) =>
    [primera ?? '', ...(v ?? '').split('|')].map((n) => n.trim()).filter((n) => n.length > 0);

  const cuentas = separadas(raw.accountNumbers);
  const nombres = separadas(raw.holderAliases, raw.holder);
  if (cuentas.length === 0 && nombres.length === 0) return null;
  return {
    bankNames: separadas(raw.bankAliases, raw.bank),
    accountNumbers: cuentas,
    holderNames: nombres,
  };
}
