export interface ServiceAuthConfig {
  /** api_client name -> bearer token */
  tokens: Record<string, string>;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
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

export default (): AppConfig => ({
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? '',
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
});
