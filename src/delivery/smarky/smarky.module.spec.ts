import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { KYSELY } from '../../database/database.module';
import { DeliveryNoticesModule } from '../../delivery-notices/delivery-notices.module';
import { DeliveryNoticesService } from '../../delivery-notices/delivery-notices.service';
import { SmarkyDeliveryService } from './smarky-delivery.service';
import { SmarkyWebhookService } from './smarky-webhook.service';

@Global()
@Module({ providers: [{ provide: KYSELY, useValue: {} }], exports: [KYSELY] })
class BaseFalsaModule {}

async function armar(delivery: Record<string, unknown>) {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            delivery,
            gateway: { baseUrl: 'http://gw', authToken: 't' },
            jwt: { secret: 'prueba', expiresIn: '1h' },
            serviceAuth: { tokens: {} },
          }),
        ],
      }),
      BaseFalsaModule,
      DeliveryNoticesModule,
    ],
  }).compile();
}

describe('SmarkyModule dentro de DeliveryNoticesModule (inyección real)', () => {
  it('con DELIVERY_PROVIDER=internal queda inerte: ni reparto ni webhook', async () => {
    const modulo = await armar({ provider: 'internal', smarky: { baseUrl: '', apiKey: '', webhookSecret: '' } });
    expect(modulo.get(DeliveryNoticesService)).toBeDefined();
    expect(modulo.get(SmarkyDeliveryService, { strict: false }).enabled).toBe(false);
    expect(modulo.get(SmarkyWebhookService, { strict: false }).enabled).toBe(false);
  });

  it('con smarky pero sin credenciales sigue apagado (usa el reparto interno)', async () => {
    const modulo = await armar({ provider: 'smarky', smarky: { baseUrl: '', apiKey: '', webhookSecret: '' } });
    expect(modulo.get(SmarkyDeliveryService, { strict: false }).enabled).toBe(false);
  });

  it('con smarky y credenciales completas se activa', async () => {
    const modulo = await armar({
      provider: 'smarky',
      smarky: { baseUrl: 'https://plataforma.test', apiKey: 'k', webhookSecret: 's' },
    });
    expect(modulo.get(SmarkyDeliveryService, { strict: false }).enabled).toBe(true);
    expect(modulo.get(SmarkyWebhookService, { strict: false }).enabled).toBe(true);
  });
});

describe('SMARKY_NOTIFY_OWN_DRIVERS en el servicio de reparto', () => {
  it('refleja la configuración', async () => {
    for (const valor of [true, false]) {
      const modulo = await armar({
        provider: 'smarky',
        smarky: { baseUrl: 'https://plataforma.test', apiKey: 'k', webhookSecret: 's', notifyOwnDrivers: valor },
      });
      expect(modulo.get(SmarkyDeliveryService, { strict: false }).notifyOwnDrivers).toBe(valor);
    }
  });
});
