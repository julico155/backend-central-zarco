import type { KapsoMediaReference } from '../../kapso/kapso.types';

/**
 * PUERTO DE MEDIA. Puerto directo de sarcoRestaurant
 * (src/lib/agent/core/media.ts, Fase 6D.2F.5C.5), adaptado a la referencia de
 * imagen que ya produce el normalizador de Kapso de Backend Central
 * (`KapsoMediaReference`: un único `url` ya resuelto por prioridad, en vez
 * del `ImageAttachment` con transient/facts separados de sarcoRestaurant).
 *
 * Agent Core no descarga nada ni conoce Kapso: pide una imagen por esta
 * interfaz y recibe un data URL. El adaptador real envuelve
 * `KapsoMediaResolverService` (ya existente en `../../kapso`, con su propia
 * lista blanca de hosts) — ver `../kapso-media-resolver.adapter.ts`.
 *
 * El resultado NUNCA se persiste: vive lo que dura el turno.
 */

export const MEDIA_TIMEOUT_MS = 8_000;

/**
 * PRESUPUESTO DEL TURNO. Un lote admite varios mensajes; sin tope, varias
 * fotos pesadas dispararían el tiempo y la memoria de una sola invocación.
 */
export interface TurnMediaLimits {
  /** Cuántas imágenes se INTENTAN resolver en un turno. */
  maxImages: number;
  /** Suma de bytes de todas las imágenes del turno. */
  maxTotalBytes: number;
  /** Tiempo total para resolver el CONJUNTO, no cada una. */
  maxTotalMs: number;
  /** Techo por descarga individual. */
  maxPerImageMs: number;
}

export const DEFAULT_TURN_MEDIA_LIMITS: TurnMediaLimits = {
  maxImages: 3,
  maxTotalBytes: 12 * 1024 * 1024,
  maxTotalMs: 12_000,
  maxPerImageMs: MEDIA_TIMEOUT_MS,
};

export type MediaResolveError =
  | 'unsupported_mime'
  | 'too_large'
  | 'timeout'
  | 'unavailable'
  | 'not_configured'
  | 'blocked_url'
  | 'too_many_images'
  | 'turn_bytes_exceeded'
  | 'turn_budget_exhausted';

export type MediaSource = 'transient_kapso' | 'media_id';

export type ResolveImageResult =
  | {
      ok: true;
      /** `data:<mime>;base64,<...>` listo para `input_image`. NUNCA se persiste. */
      dataUrl: string;
      source: MediaSource;
      byteSize: number;
      mimeType: string;
    }
  | { ok: false; error: MediaResolveError };

export interface ResolveImageOptions {
  /** Techo de tiempo para ESTA descarga, ya recortado por lo que quede del presupuesto del turno. */
  timeoutMs?: number;
}

export interface MediaResolverPort {
  resolveImage(
    media: KapsoMediaReference,
    phoneNumberId: string | null,
    options?: ResolveImageOptions,
  ): Promise<ResolveImageResult>;
}

/**
 * Contable del presupuesto de un turno. FAIL CLOSED: cuando no hay sitio, la
 * imagen NO se descarga. El orden se preserva solo, porque las decisiones se
 * toman recorriendo el burst de principio a fin.
 */
export interface TurnMediaBudget {
  admit(
    declaredBytes: number | null,
  ): { ok: true; timeoutMs: number } | { ok: false; error: MediaResolveError };
  account(byteSize: number): { ok: true } | { ok: false; error: MediaResolveError };
  totalBytes(): number;
}

export function createTurnMediaBudget(options?: {
  limits?: TurnMediaLimits;
  now?: () => number;
}): TurnMediaBudget {
  const limits = options?.limits ?? DEFAULT_TURN_MEDIA_LIMITS;
  const now = options?.now ?? (() => Date.now());
  const deadline = now() + limits.maxTotalMs;

  let intentos = 0;
  let bytes = 0;

  return {
    admit(declaredBytes) {
      if (intentos >= limits.maxImages) return { ok: false, error: 'too_many_images' };
      if (declaredBytes !== null && bytes + declaredBytes > limits.maxTotalBytes) {
        return { ok: false, error: 'turn_bytes_exceeded' };
      }
      const restante = deadline - now();
      if (restante <= 0) return { ok: false, error: 'turn_budget_exhausted' };

      intentos += 1;
      return { ok: true, timeoutMs: Math.min(limits.maxPerImageMs, restante) };
    },
    account(byteSize) {
      if (bytes + byteSize > limits.maxTotalBytes) {
        return { ok: false, error: 'turn_bytes_exceeded' };
      }
      bytes += byteSize;
      return { ok: true };
    },
    totalBytes: () => bytes,
  };
}
