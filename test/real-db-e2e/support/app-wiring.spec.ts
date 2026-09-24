import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import { buildAppEnv, buildE2EApp, type E2EApp } from './app';
import { FAKE_KAPSO_BASE, FAKE_TELEGRAM_BASE } from './fake-externals';
import { inboundText } from './kapso-payloads';

/**
 * Cableado del AppModule de pruebas SIN base de datos: las URLs apuntan a un
 * puerto cerrado y solo se ejercita lo que no consulta (los pools son perezosos).
 */
describe('AppModule del E2E real-db (sin DB)', () => {
  let e2e: E2EApp;
  let secret: string;
  const built = buildAppEnv({
    centralUrl: 'postgres://u:p@127.0.0.1:1/central',
    agentUrl: 'postgres://u:p@127.0.0.1:1/agent',
    phone: '59170001234',
  });

  beforeAll(async () => {
    secret = built.app.webhookSecret;
    e2e = await buildE2EApp(built.env, built.app);
  }, 60_000);

  afterAll(async () => {
    await e2e.close();
  });

  it('los 4 crons están desactivados: no hay ningún CronJob registrado', () => {
    expect(e2e.app.get(SchedulerRegistry).getCronJobs().size).toBe(0);
  });

  it('la configuración apunta SOLO a hosts falsos y activa el agente para el teléfono E2E', () => {
    const config = e2e.app.get(ConfigService);
    expect(config.get('kapso.apiBaseUrl')).toBe(FAKE_KAPSO_BASE);
    expect(config.get('telegram.apiBaseUrl')).toBe(FAKE_TELEGRAM_BASE);
    expect(config.get('baneco.baseUrl')).toBe('');
    expect(config.get('gateway.baseUrl')).toBe('');
    expect(config.get('mapbox.accessToken')).toBe('');
    expect(config.get('agent.enabled')).toBe('true');
    expect(config.get('agent.testPhones')).toBe('59170001234');
    // Cada base usa su propia cadena y lleva application_name e2e-.
    const central = String(config.get('databaseUrl'));
    const agent = String(config.get('agentDatabaseUrl'));
    expect(central).not.toBe(agent);
    expect(new URL(central).searchParams.get('application_name')).toBe('e2e-harness-app');
    expect(new URL(agent).searchParams.get('application_name')).toBe('e2e-harness-app');
  });

  it('el Banco Económico es el falso (nunca el cliente HTTP real)', async () => {
    const { BanecoClientService } = await import('../../../src/baneco/baneco-client.service');
    expect(e2e.app.get(BanecoClientService)).toBe(e2e.baneco);
  });

  it('un webhook con firma inválida se rechaza antes de tocar ninguna base', async () => {
    const { raw, headers } = inboundText(
      { phone: '59170001234', phoneNumberId: 'pn', wamid: 'e2e-w', body: 'hola', eventId: 'e2e-e' },
      'otro-secreto',
    );
    const res = await request(e2e.app.getHttpServer())
      .post('/kapso/webhook')
      .set(headers)
      .send(raw);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'invalid_signature' });
    expect(e2e.externals.violations).toEqual([]);
  });

  it('la firma correcta pasa la verificación (falla después, al no haber base: 500, nunca 401)', async () => {
    const { raw, headers } = inboundText(
      { phone: '59170001234', phoneNumberId: 'pn', wamid: 'e2e-w', body: 'hola', eventId: 'e2e-e' },
      secret,
    );
    const res = await request(e2e.app.getHttpServer())
      .post('/kapso/webhook')
      .set(headers)
      .send(raw);
    expect(res.status).not.toBe(401);
    expect(e2e.externals.violations).toEqual([]);
  });
});
