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
  };
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
  },
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
});
