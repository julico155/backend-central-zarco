export interface ServiceAuthConfig {
  /** api_client name -> bearer token */
  tokens: Record<string, string>;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  /** Orígenes permitidos por CORS. Vacío = ninguno (el backend queda solo para clientes que no son navegadores). */
  corsOrigins: string[];
  serviceAuth: ServiceAuthConfig;
  gateway: {
    baseUrl: string;
    authToken: string;
    /** Máximo 60 s: debe quedar por debajo del lease de notification_jobs (5 min). */
    timeoutMs: number;
  };
  kapso: {
    apiKey: string;
    webhookSecret: string;
    phoneNumberId: string;
    apiBaseUrl: string;
  };
  /** ACK durable: persiste y responde antes de ejecutar el dispatcher. */
  webhookAsyncAck: boolean;
  jwt: {
    secret: string;
    expiresIn: string;
  };
  mapbox: {
    /** Vacío = sin credenciales todavía, DeliveryModule usa haversine (línea recta). */
    accessToken: string;
  };
  s3: {
    /** Vacío (sin bucket) = sin credenciales todavía, PaymentProofsModule usa disco local. */
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** Solo para proveedores S3-compatibles que no son AWS (Cloudflare R2, MinIO, etc.). Vacío = AWS S3. */
    endpoint: string;
  };
  baneco: {
    baseUrl: string;
    username: string;
    password: string;
    aesKey: string;
    account: string;
  };
  /**
   * 'manual' = mientras el banco no habilite producción: el POS nunca le
   * pide un QR real a Baneco, el cajero confirma el cobro a ojo (con SU
   * propio QR fuera del sistema) vía `confirm-presencial`. Solo afecta
   * channel='pos' — WhatsApp sigue con el QR real de Baneco. Interruptor
   * por variable de entorno (no una rama aparte) para no arrastrar un merge
   * divergente: cuando el banco dé el ok, se saca la variable y listo.
   */
  posQrMode: 'bank' | 'manual';
  /** Minutos tras los que un pedido sin pagar se cancela solo (WhatsApp y POS). */
  unpaidOrderTtlMinutes: number;
  /** Radio (m) alrededor del local dentro del cual un repartidor puede aceptar un pedido de delivery. */
  deliveryAcceptRadiusMeters: number;
  /** Radio (m) entre dos pedidos "disponibles" para reportarlos como cercanos entre sí (nunca se expone su lat/lng cruda antes de aceptar). */
  deliveryNearbyRadiusMeters: number;
  /**
   * Configuración del agente conversacional, sin interpretar: la forma es
   * validación (una cadena), el SIGNIFICADO lo decide `sarco-agent/core/eligibility.ts`
   * (parseAccessMode/parseTestPhones), igual que en sarcoRestaurant. Así un
   * valor mal escrito no puede abrir el agente por accidente.
   */
  menu: {
    /** HMAC del token de sesión del menú (mismo esquema que sarcoRestaurant: sha256 base64url). Vacío = el menú web no puede validar ninguna sesión. */
    sessionSecret: string;
    /** Origen del menú web (Next.js), SIN barra final. El CTA arma `${webBaseUrl}/menu?session=<token>`. */
    webBaseUrl: string;
    /** Imagen de portada del CTA "Ver menú" (header del mensaje interactive cta_url). */
    coverImageUrl: string;
  };
  agent: {
    /** Solo la cadena exacta 'true' enciende el agente. */
    enabled: string;
    /** Solo 'all' abre el agente a cualquier cliente; cualquier otro valor cae en 'allowlist'. */
    accessMode: string;
    /** Teléfonos de prueba separados por coma, sin normalizar todavía. */
    testPhones: string;
    apiKey: string;
    model: string;
    /** Modelo para turnos con imagen. Vacío = se usa el de texto. */
    visionModel: string;
    /** Minutos que se pausa el agente tras un takeover humano desde WhatsApp Business App. */
    humanTakeoverPauseMinutes: string;
  };
  /**
   * Análisis visual de comprobantes (Fase 2D). Usa la MISMA
   * `OPENAI_API_KEY` que el agente (`agent.apiKey`), pero un modelo propio:
   * leer un comprobante es una tarea estructurada distinta de conversar, y
   * sarcoRestaurant ya la separaba por eso (PAYMENT_PROOF_ANALYSIS_MODEL).
   */
  paymentProof: {
    /** Solo la cadena exacta 'true' enciende el análisis. Vacío/otro valor = capturar sin analizar (analysis_status queda 'pending'). */
    analysisEnabled: string;
    /** Vacío = 'gpt-5-mini' (el mismo default que sarcoRestaurant). */
    analysisModel: string;
    /** Cuenta(s) donde cobra el negocio, separadas por "|". Sin esto no hay contra qué contrastar y el veredicto nunca puede afirmar un mismatch — ver `expected-account.ts`. */
    expectedAccountNumbers: string;
    expectedHolder: string;
    /** Alias adicionales del titular, separados por "|". */
    expectedHolderAliases: string;
    expectedBank: string;
    /** Alias adicionales del banco (siglas, nombre largo), separados por "|". */
    expectedBankAliases: string;
  };
  /** Telegram directo (Fase 2E): avisos al grupo de reparto y de atención humana. */
  telegram: {
    botToken: string;
    /** Grupo de reparto (y 'staff-group', que sarcoRestaurant ya mapeaba al mismo chat). */
    chatId: string;
    /** Grupo de atención humana. Vacío = cae al chat de reparto (igual que sarcoRestaurant). */
    handoffChatId: string;
    /** Solo para pruebas/proxys. Vacío = https://api.telegram.org. */
    apiBaseUrl: string;
  };
}

function parseServiceAuthTokens(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const entries = raw
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [apiClient, token] = pair.split(':');
      return [apiClient?.trim(), token?.trim()] as [string, string];
    })
    .filter(([apiClient, token]) => Boolean(apiClient) && Boolean(token));
  return Object.fromEntries(entries);
}

function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export default (): AppConfig => ({
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
  serviceAuth: {
    tokens: parseServiceAuthTokens(process.env.SERVICE_AUTH_TOKENS),
  },
  gateway: {
    baseUrl: process.env.GATEWAY_BASE_URL ?? '',
    authToken: process.env.GATEWAY_AUTH_TOKEN ?? '',
    timeoutMs: Math.min(
      Number(process.env.GATEWAY_TIMEOUT_MS) > 0 ? Number(process.env.GATEWAY_TIMEOUT_MS) : 30_000,
      60_000,
    ),
  },
  kapso: {
    apiKey: process.env.KAPSO_API_KEY ?? '',
    webhookSecret: process.env.KAPSO_WEBHOOK_SECRET ?? '',
    phoneNumberId: process.env.KAPSO_PHONE_NUMBER_ID ?? '',
    // URL oficial confirmada por la documentación de Kapso (meta/whatsapp
    // Cloud API compatible). KAPSO_API_BASE_URL permite sobreescribirla solo
    // para pruebas locales.
    apiBaseUrl: (
      process.env.KAPSO_API_BASE_URL ?? 'https://api.kapso.ai/meta/whatsapp/v24.0'
    ).replace(/\/+$/, ''),
  },
  webhookAsyncAck: process.env.WEBHOOK_ASYNC_ACK === 'true',
  jwt: {
    secret: process.env.JWT_SECRET ?? '',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '8h',
  },
  mapbox: {
    accessToken: process.env.MAPBOX_ACCESS_TOKEN ?? '',
  },
  s3: {
    bucket: process.env.PAYMENT_PROOFS_S3_BUCKET ?? '',
    region: process.env.PAYMENT_PROOFS_S3_REGION ?? 'auto',
    accessKeyId: process.env.PAYMENT_PROOFS_S3_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.PAYMENT_PROOFS_S3_SECRET_ACCESS_KEY ?? '',
    endpoint: process.env.PAYMENT_PROOFS_S3_ENDPOINT ?? '',
  },
  baneco: {
    // Sin "/" final: el cliente arma `${baseUrl}/api/...` y una barra de más da 404 en el gateway del banco.
    baseUrl: (process.env.BANECO_BASE_URL ?? '').replace(/\/+$/, ''),
    username: process.env.BANECO_USERNAME ?? '',
    password: process.env.BANECO_PASSWORD ?? '',
    aesKey: process.env.BANECO_AES_KEY ?? '',
    account: process.env.BANECO_ACCOUNT ?? '',
  },
  posQrMode: process.env.POS_QR_MODE === 'manual' ? 'manual' : 'bank',
  deliveryAcceptRadiusMeters:
    Number(process.env.DELIVERY_ACCEPT_RADIUS_METERS) > 0
      ? Number(process.env.DELIVERY_ACCEPT_RADIUS_METERS)
      : 150,
  deliveryNearbyRadiusMeters:
    Number(process.env.DELIVERY_NEARBY_RADIUS_METERS) > 0
      ? Number(process.env.DELIVERY_NEARBY_RADIUS_METERS)
      : 500,
  unpaidOrderTtlMinutes:
    Number(process.env.UNPAID_ORDER_TTL_MINUTES) > 0
      ? Number(process.env.UNPAID_ORDER_TTL_MINUTES)
      : 10,
  menu: {
    sessionSecret: process.env.MENU_SESSION_SECRET ?? '',
    webBaseUrl: (process.env.MENU_WEB_BASE_URL ?? '').replace(/\/+$/, ''),
    coverImageUrl: process.env.MENU_COVER_IMAGE_URL ?? '',
  },
  agent: {
    enabled: process.env.AI_ENABLED ?? '',
    accessMode: process.env.AI_ACCESS_MODE ?? '',
    testPhones: process.env.AI_TEST_PHONES ?? process.env.AI_TEST_PHONE ?? '',
    apiKey: process.env.OPENAI_API_KEY ?? '',
    model: process.env.OPENAI_MODEL ?? '',
    visionModel: process.env.AI_VISION_MODEL ?? '',
    humanTakeoverPauseMinutes: process.env.HUMAN_TAKEOVER_PAUSE_MINUTES ?? '',
  },
  paymentProof: {
    analysisEnabled: process.env.PAYMENT_PROOF_ANALYSIS_ENABLED ?? '',
    analysisModel: process.env.PAYMENT_PROOF_ANALYSIS_MODEL ?? '',
    expectedAccountNumbers: process.env.PAYMENT_PROOF_EXPECTED_ACCOUNT_NUMBERS ?? '',
    expectedHolder: process.env.PAYMENT_PROOF_EXPECTED_HOLDER ?? '',
    expectedHolderAliases: process.env.PAYMENT_PROOF_EXPECTED_HOLDER_ALIASES ?? '',
    expectedBank: process.env.PAYMENT_PROOF_EXPECTED_BANK ?? '',
    expectedBankAliases: process.env.PAYMENT_PROOF_EXPECTED_BANK_ALIASES ?? '',
  },
  telegram: {
    botToken: (process.env.TELEGRAM_BOT_TOKEN ?? '').trim(),
    chatId: (process.env.TELEGRAM_CHAT_ID ?? '').trim(),
    handoffChatId: (process.env.TELEGRAM_HANDOFF_CHAT_ID ?? '').trim(),
    apiBaseUrl: (process.env.TELEGRAM_API_BASE_URL ?? '').trim().replace(/\/+$/, ''),
  },
});
