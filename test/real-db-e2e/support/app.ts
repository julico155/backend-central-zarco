import { randomBytes } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { json, urlencoded } from 'express';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { AgentDatabase } from '../../../src/database/agent-types';
import type { Database } from '../../../src/database/types';
import { WriteAudit } from './audit';
import {
  FAKE_KAPSO_BASE,
  FAKE_MENU_BASE,
  FAKE_TELEGRAM_BASE,
  FakeBaneco,
  FakeExternals,
} from './fake-externals';
import { withApplicationName } from './options';

/** Origen del restaurante y del cliente en el E2E: ~1,3 km, banda 2 de la tarifa. */
export const E2E_RESTAURANT = { latitude: -17.783, longitude: -63.182 };
export const E2E_CUSTOMER_PIN = { latitude: -17.79, longitude: -63.19 };

export interface E2EAppEnv {
  webhookSecret: string;
  telegramToken: string;
  telegramChatId: string;
  phoneNumberId: string;
  menuBase: string;
}

/** Variables de la app SOLO para este proceso: secretos inventados y hosts `.invalid`. */
export function buildAppEnv(input: { centralUrl: string; agentUrl: string; phone: string }): {
  env: NodeJS.ProcessEnv;
  app: E2EAppEnv;
} {
  const app: E2EAppEnv = {
    webhookSecret: `e2e-secret-${randomBytes(8).toString('hex')}`,
    telegramToken: `e2e-telegram-${randomBytes(4).toString('hex')}`,
    telegramChatId: '-100000000000',
    phoneNumberId: 'e2e-phone-number-id',
    menuBase: FAKE_MENU_BASE,
  };
  const env: NodeJS.ProcessEnv = {
    DATABASE_URL: withApplicationName(input.centralUrl, 'e2e-harness-app'),
    AGENT_DATABASE_URL: withApplicationName(input.agentUrl, 'e2e-harness-app'),
    JWT_SECRET: randomBytes(16).toString('hex'),
    SERVICE_AUTH_TOKENS: `whatsapp-gateway:${randomBytes(8).toString('hex')}`,
    KAPSO_API_KEY: 'e2e-fake-kapso-key',
    KAPSO_WEBHOOK_SECRET: app.webhookSecret,
    KAPSO_PHONE_NUMBER_ID: app.phoneNumberId,
    KAPSO_API_BASE_URL: FAKE_KAPSO_BASE,
    WEBHOOK_ASYNC_ACK: '',
    OPENAI_API_KEY: 'e2e-fake-openai-key',
    OPENAI_MODEL: '',
    AI_VISION_MODEL: '',
    AI_ENABLED: 'true',
    AI_ACCESS_MODE: 'allowlist',
    AI_TEST_PHONES: input.phone,
    AI_TEST_PHONE: '',
    HUMAN_TAKEOVER_PAUSE_MINUTES: '',
    TELEGRAM_BOT_TOKEN: app.telegramToken,
    TELEGRAM_CHAT_ID: app.telegramChatId,
    TELEGRAM_HANDOFF_CHAT_ID: '',
    TELEGRAM_API_BASE_URL: FAKE_TELEGRAM_BASE,
    MENU_SESSION_SECRET: randomBytes(24).toString('hex'),
    MENU_WEB_BASE_URL: FAKE_MENU_BASE,
    MENU_COVER_IMAGE_URL: `${FAKE_MENU_BASE}/cover.jpg`,
    MAPBOX_ACCESS_TOKEN: '',
    POS_QR_MODE: '',
    PAYMENT_PROOF_ANALYSIS_ENABLED: '',
    BANECO_BASE_URL: '',
    BANECO_USERNAME: '',
    BANECO_PASSWORD: '',
    BANECO_AES_KEY: '',
    BANECO_ACCOUNT: '',
    GATEWAY_BASE_URL: '',
    GATEWAY_AUTH_TOKEN: '',
    PAYMENT_PROOFS_S3_BUCKET: '',
    CORS_ORIGINS: '',
  };
  return { env, app };
}

function boliviaHour(now = new Date()): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/La_Paz',
      hour: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .find((p) => p.type === 'hour')?.value ?? 0,
  );
}

export interface E2EApp {
  app: INestApplication;
  externals: FakeExternals;
  baneco: FakeBaneco;
  centralAudit: WriteAudit;
  agentAudit: WriteAudit;
  close(): Promise<void>;
}

/**
 * Levanta el AppModule REAL contra las dos bases, con:
 *  - los 4 crons reemplazados por objetos vacíos (nadie recupera, expira ni sondea);
 *  - Banco Económico y OperationalSettings sustituidos (esta última solo EN MEMORIA:
 *    horario siempre abierto y coordenadas del restaurante fijas; la fila real no se toca);
 *  - fetch/http falsos (Kapso, OpenAI, Telegram);
 *  - conexiones auditadas: toda sentencia que escribe queda registrada.
 * Se importa AppModule de forma perezosa: `process.env` ya tiene que estar listo.
 */
export async function buildE2EApp(env: NodeJS.ProcessEnv, appEnv: E2EAppEnv): Promise<E2EApp> {
  Object.assign(process.env, env);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { AppModule } = require('../../../src/app.module');
  const { KYSELY } = require('../../../src/database/database.module');
  const { AGENT_KYSELY } = require('../../../src/database/agent-database.module');
  const { UnpaidOrdersExpiryCron } = require('../../../src/orders/unpaid-orders-expiry.cron');
  const { QrPaymentsPollCron } = require('../../../src/bank-qr/qr-payments-poll.cron');
  const {
    NotificationRecoveryCron,
  } = require('../../../src/notifications-out/notification-recovery.cron');
  const { WebhookInboxCron } = require('../../../src/webhook-inbox/webhook-inbox.cron');
  const { BanecoClientService } = require('../../../src/baneco/baneco-client.service');
  const {
    OperationalSettingsService,
  } = require('../../../src/operational-settings/operational-settings.service');
  const { DomainExceptionFilter } = require('../../../src/common/filters/domain-exception.filter');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const externals = new FakeExternals(appEnv.telegramToken);
  const baneco = new FakeBaneco();
  const centralAudit = new WriteAudit();
  const agentAudit = new WriteAudit();
  externals.install();

  const noop = {};
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(UnpaidOrdersExpiryCron)
    .useValue(noop)
    .overrideProvider(QrPaymentsPollCron)
    .useValue(noop)
    .overrideProvider(NotificationRecoveryCron)
    .useValue(noop)
    .overrideProvider(WebhookInboxCron)
    .useValue(noop)
    .overrideProvider(BanecoClientService)
    .useValue(baneco)
    .overrideProvider(KYSELY)
    .useFactory({
      factory: () =>
        new Kysely<Database>({
          dialect: new PostgresDialect({ pool: new Pool({ connectionString: env.DATABASE_URL }) }),
          log: centralAudit.log,
        }),
    })
    .overrideProvider(AGENT_KYSELY)
    .useFactory({
      factory: () =>
        new Kysely<AgentDatabase>({
          dialect: new PostgresDialect({
            pool: new Pool({ connectionString: env.AGENT_DATABASE_URL }),
          }),
          log: agentAudit.log,
        }),
    })
    .overrideProvider(OperationalSettingsService)
    .useFactory({
      factory: (db: Kysely<Database>) => {
        const real = new OperationalSettingsService(db);
        const hour = boliviaHour();
        return new Proxy(real, {
          get(target, prop) {
            if (prop === 'getRow') {
              return async () => ({
                ...(await target.getRow()),
                business_opens_hour: hour,
                business_closes_hour: (hour + 12) % 24,
                restaurant_latitude: E2E_RESTAURANT.latitude,
                restaurant_longitude: E2E_RESTAURANT.longitude,
              });
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      inject: [KYSELY],
    })
    .compile();

  const app = moduleRef.createNestApplication({ bodyParser: false });
  app.use(
    json({
      limit: '10mb',
      verify: (request, _response, buffer) => {
        (request as typeof request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: '10mb' }));
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new DomainExceptionFilter());
  await app.init();

  return {
    app,
    externals,
    baneco,
    centralAudit,
    agentAudit,
    async close() {
      await app.close();
      externals.restore();
    },
  };
}
