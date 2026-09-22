import { HttpStatus } from '@nestjs/common';
import { NotificationJobPayload } from '../notifications-out/notification-job.types';
import {
  canSuppressNotifications,
  NotificationSuppressionNotAllowedError,
  shadowNotifier,
} from './shadow-orders';

describe('canSuppressNotifications', () => {
  it('autoriza a un api_client de servicio que está en la allowlist', () => {
    expect(canSuppressNotifications('whatsapp-gateway', 'service', ['whatsapp-gateway'])).toBe(
      true,
    );
  });

  it('rechaza a un api_client de servicio que no está en la allowlist', () => {
    expect(canSuppressNotifications('pos', 'service', ['whatsapp-gateway'])).toBe(false);
  });

  // El agujero que justifica que exista `apiClientKind`: un JWT de staff queda
  // marcado con el api_client 'pos'. Si solo mirásemos el nombre, poner 'pos'
  // en la allowlist le daría la capacidad a cualquier cajero logueado.
  it('rechaza a una sesión de staff aunque su api_client esté en la allowlist', () => {
    expect(canSuppressNotifications('pos', 'staff', ['pos'])).toBe(false);
  });

  it('no autoriza a nadie con la allowlist vacía (el default en producción)', () => {
    expect(canSuppressNotifications('whatsapp-gateway', 'service', [])).toBe(false);
  });

  it('el error de autorización es 403 con código de dominio estable', () => {
    const error = new NotificationSuppressionNotAllowedError('pos');
    expect(error.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(error.code).toBe('notification_suppression_not_allowed');
  });
});

describe('shadowNotifier', () => {
  function job(kind: string): NotificationJobPayload {
    return {
      channel: 'whatsapp',
      kind,
      targetRef: 'order-1',
      payload: { customerId: 'customer-1', text: 'hola' },
    } as NotificationJobPayload;
  }

  it('descarta el aviso y avisa qué se suprimió, sin propagar errores', async () => {
    const suppressed: string[] = [];
    const notifier = shadowNotifier((j) => suppressed.push(j.kind));

    await expect(notifier.notifyNow(job('order_received'))).resolves.toBeUndefined();
    await expect(notifier.notifyNow(job('qr_confirmation'))).resolves.toBeUndefined();

    expect(suppressed).toEqual(['order_received', 'qr_confirmation']);
  });

  // Es un sumidero, no una lista de kinds prohibidos: un aviso nuevo que se
  // agregue mañana a POST /orders queda silenciado solo.
  it('silencia cualquier kind, incluso uno que todavía no existe', async () => {
    const suppressed: string[] = [];
    const notifier = shadowNotifier((j) => suppressed.push(j.kind));

    await notifier.notifyNow(job('aviso_futuro'));

    expect(suppressed).toEqual(['aviso_futuro']);
  });
});
