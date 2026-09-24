import http from 'node:http';
import https from 'node:https';

/** Hosts inventados (TLD `.invalid`, nunca resuelve): la app se configura con estos y NUNCA con los reales. */
export const FAKE_KAPSO_BASE = 'https://kapso.e2e.invalid/meta/whatsapp/v24.0';
export const FAKE_TELEGRAM_BASE = 'https://telegram.e2e.invalid';
export const FAKE_MENU_BASE = 'https://menu.e2e.invalid';
export const OPENAI_URL = 'https://api.openai.com/v1/responses';

export interface RecordedCall {
  service: 'kapso' | 'telegram' | 'openai';
  method: string;
  /** Ruta sin el host. */
  path: string;
  body: unknown;
}

export class UnexpectedExternalRequestError extends Error {
  constructor(what: string) {
    super(`Petición externa NO contemplada por el E2E: ${what}`);
    this.name = 'UnexpectedExternalRequestError';
  }
}

export type OpenAiResponder = (
  body: Record<string, unknown>,
  callNumber: number,
) => Record<string, unknown>;

/** Respuesta por defecto: la primera vuelta llama a `send_menu`; si ya hay resultado de herramienta, cierra con texto. */
export const defaultOpenAiResponder: OpenAiResponder = (body, n) => {
  const input = JSON.stringify(body.input ?? '');
  if (input.includes('function_call_output')) {
    return {
      model: 'gpt-4o-mini',
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Listo, te envié el menú.' }] },
      ],
    };
  }
  return {
    model: 'gpt-4o-mini',
    status: 'completed',
    output: [
      { type: 'function_call', call_id: `e2e-call-${n}`, name: 'send_menu', arguments: '{}' },
    ],
  };
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function parseBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  if (body instanceof FormData) {
    return { multipart: [...body.keys()] };
  }
  return undefined;
}

/** Host destino de los argumentos de `http(s).request(url | options, ...)`. */
function requestHost(args: unknown[]): string {
  const [first, second] = args;
  if (typeof first === 'string') {
    try {
      return new URL(first).hostname;
    } catch {
      return first;
    }
  }
  if (first instanceof URL) return first.hostname;
  const options = (first ?? second ?? {}) as { hostname?: string; host?: string };
  return options.hostname ?? options.host ?? 'localhost';
}

function isLoopback(host: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'].includes(host);
}

/**
 * Kapso, OpenAI y Telegram simulados con un `fetch` falso. Cualquier otra URL
 * (y cualquier `http(s).request`) se registra en `violations` y lanza: el test
 * comprueba `violations` en cada punto de control, porque una app que captura el
 * error podría seguir adelante en silencio.
 */
export class FakeExternals {
  readonly calls: RecordedCall[] = [];
  readonly violations: string[] = [];
  openAiResponder: OpenAiResponder = defaultOpenAiResponder;

  private originalFetch: typeof fetch | null = null;
  private originalHttp: { request: typeof http.request; get: typeof http.get } | null = null;
  private originalHttps: { request: typeof https.request; get: typeof https.get } | null = null;
  private outboundSeq = 0;
  private telegramSeq = 0;
  private mediaSeq = 0;

  constructor(private readonly telegramToken: string) {}

  install(): void {
    this.originalFetch = global.fetch;
    global.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      this.handle(input, init)) as typeof fetch;

    // Solo el tráfico HACIA LA PROPIA MÁQUINA (supertest → la app) pasa: cualquier otro destino es una violación.
    const guard =
      (label: string, original: unknown, owner: object) =>
      (...args: unknown[]) => {
        const host = requestHost(args);
        if (isLoopback(host)) return (original as (...a: unknown[]) => unknown).apply(owner, args);
        const error = new UnexpectedExternalRequestError(`${label} → ${host}`);
        this.violations.push(error.message);
        throw error;
      };
    this.originalHttp = { request: http.request, get: http.get };
    this.originalHttps = { request: https.request, get: https.get };
    (http as { request: unknown }).request = guard('node:http.request', http.request, http);
    (http as { get: unknown }).get = guard('node:http.get', http.get, http);
    (https as { request: unknown }).request = guard('node:https.request', https.request, https);
    (https as { get: unknown }).get = guard('node:https.get', https.get, https);
  }

  restore(): void {
    if (this.originalFetch) global.fetch = this.originalFetch;
    if (this.originalHttp) Object.assign(http, this.originalHttp);
    if (this.originalHttps) Object.assign(https, this.originalHttps);
    this.originalFetch = null;
    this.originalHttp = null;
    this.originalHttps = null;
  }

  callsTo(service: RecordedCall['service']): RecordedCall[] {
    return this.calls.filter((c) => c.service === service);
  }

  /** Mensajes salientes de Kapso (`/messages`), en orden. */
  kapsoMessages(): Record<string, unknown>[] {
    return this.callsTo('kapso')
      .filter((c) => c.path.endsWith('/messages'))
      .map((c) => c.body as Record<string, unknown>);
  }

  telegramMessages(): Record<string, unknown>[] {
    return this.callsTo('telegram').map((c) => c.body as Record<string, unknown>);
  }

  private handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input.toString() : input.url,
    );
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = parseBody(init);
    const href = `${method} ${url.origin}${url.pathname}`;

    if (`${url.origin}${url.pathname}` === OPENAI_URL) {
      this.calls.push({ service: 'openai', method, path: url.pathname, body });
      const n = this.callsTo('openai').length;
      return Promise.resolve(
        jsonResponse(this.openAiResponder(body as Record<string, unknown>, n)),
      );
    }

    if (url.origin === new URL(FAKE_KAPSO_BASE).origin) {
      const path = url.pathname.replace('/meta/whatsapp/v24.0', '');
      if (method === 'POST' && /^\/[^/]+\/messages$/.test(path)) {
        this.calls.push({ service: 'kapso', method, path, body });
        return Promise.resolve(
          jsonResponse({ messages: [{ id: `wamid.e2e.out.${(this.outboundSeq += 1)}` }] }),
        );
      }
      if (method === 'POST' && /^\/[^/]+\/media$/.test(path)) {
        this.calls.push({ service: 'kapso', method, path, body });
        return Promise.resolve(jsonResponse({ id: `e2e-media-${(this.mediaSeq += 1)}` }));
      }
    }

    if (url.origin === FAKE_TELEGRAM_BASE) {
      if (method === 'POST' && url.pathname === `/bot${this.telegramToken}/sendMessage`) {
        this.calls.push({ service: 'telegram', method, path: '/sendMessage', body });
        return Promise.resolve(
          jsonResponse({ ok: true, result: { message_id: (this.telegramSeq += 1) } }),
        );
      }
    }

    const message = new UnexpectedExternalRequestError(href).message;
    this.violations.push(message);
    return Promise.reject(new UnexpectedExternalRequestError(href));
  }
}

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Banco Económico simulado (reemplaza a `BanecoClientService`, que usa node:http y no fetch). */
export class FakeBaneco {
  readonly generated: { qrId: string; transactionId: string; amount: number }[] = [];
  readonly statusChecks: string[] = [];
  readonly cancelled: string[] = [];
  private readonly paid = new Set<string>();
  private seq = 0;

  async generateQR(params: { transactionId: string; amount: number }) {
    const qrId = `e2e-qr-${(this.seq += 1)}-${params.transactionId}`;
    this.generated.push({ qrId, transactionId: params.transactionId, amount: params.amount });
    return { qrId, qrImageBase64: PNG_1X1, raw: { responseCode: 0, message: 'e2e' } };
  }

  async statusQR(qrId: string) {
    this.statusChecks.push(qrId);
    return { statusQrCode: (this.paid.has(qrId) ? 1 : 0) as 0 | 1 | 9, raw: { e2e: true } };
  }

  async cancelQR(qrId: string): Promise<void> {
    this.cancelled.push(qrId);
  }

  /** El banco reporta este QR como pagado en la próxima consulta `statusQR`. */
  markPaid(qrId: string): void {
    this.paid.add(qrId);
  }
}
