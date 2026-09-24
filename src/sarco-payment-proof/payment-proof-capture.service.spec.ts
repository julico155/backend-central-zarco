import { PaymentProofCaptureService } from './payment-proof-capture.service';
import { DomainException } from '../common/exceptions/domain-exception';
import type { NormalizedKapsoEvent } from '../kapso/kapso.types';

function textEvent(overrides: Partial<NormalizedKapsoEvent> = {}): NormalizedKapsoEvent {
  return {
    eventName: 'whatsapp.message.received',
    eventId: 'event-1',
    envelopeIndex: 0,
    messageId: 'wamid.1',
    customerPhone: '59170000000',
    conversationId: null,
    phoneNumberId: 'phone-1',
    contentType: 'text',
    text: 'hola',
    image: null,
    audio: null,
    location: null,
    interactive: null,
    ...overrides,
  };
}

function imageEvent(overrides: Partial<NormalizedKapsoEvent> = {}): NormalizedKapsoEvent {
  return textEvent({
    contentType: 'image',
    text: null,
    image: {
      id: 'media-1',
      url: 'https://app.kapso.ai/media/a',
      mimeType: 'image/jpeg',
      caption: null,
    },
    ...overrides,
  });
}

function fakeCustomers() {
  return {
    findOrCreate: jest
      .fn()
      .mockResolvedValue({ id: 'customer-1', name: null, phone: '59170000000', email: null }),
  };
}

function fakeMedia(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    resolve: jest
      .fn()
      .mockResolvedValue({ ok: true, bytes: Buffer.from('fake-bytes'), mimeType: 'image/jpeg' }),
    ...overrides,
  };
}

function fakeProofs(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    intake: jest.fn().mockResolvedValue({
      id: 'proof-1',
      orderId: 'order-1',
      customerId: 'customer-1',
      attemptId: 'attempt-1',
      matchMethod: 'single_open_qr_order',
      routingException: null,
      captureStatus: 'stored',
      candidateCount: 1,
      createdAt: new Date().toISOString(),
    }),
    ...overrides,
  };
}

function fakeAnalysis() {
  return { analyze: jest.fn().mockResolvedValue(undefined) };
}

describe('PaymentProofCaptureService', () => {
  it('un mensaje de texto normal se salta: no toca ningún servicio', async () => {
    const customers = fakeCustomers();
    const media = fakeMedia();
    const proofs = fakeProofs();
    const analysis = fakeAnalysis();
    const service = new PaymentProofCaptureService(
      customers as never,
      media as never,
      proofs as never,
      analysis as never,
    );

    const outcome = await service.tryCapture(textEvent());

    expect(outcome).toBe('skipped');
    expect(customers.findOrCreate).not.toHaveBeenCalled();
    expect(media.resolve).not.toHaveBeenCalled();
  });

  it('una imagen SIN ningún pedido QR abierto (no_match) se trata como imagen normal, no como comprobante', async () => {
    const customers = fakeCustomers();
    const media = fakeMedia();
    const proofs = fakeProofs({
      intake: jest
        .fn()
        .mockRejectedValue(new DomainException('payment_proof_no_match', 422, 'sin match')),
    });
    const analysis = fakeAnalysis();
    const service = new PaymentProofCaptureService(
      customers as never,
      media as never,
      proofs as never,
      analysis as never,
    );

    const outcome = await service.tryCapture(imageEvent());

    expect(outcome).toBe('not_a_proof');
    expect(analysis.analyze).not.toHaveBeenCalled();
  });

  it('una imagen asociada a un pedido se captura y dispara el análisis con los bytes ya descargados', async () => {
    const customers = fakeCustomers();
    const media = fakeMedia();
    const proofs = fakeProofs();
    const analysis = fakeAnalysis();
    const service = new PaymentProofCaptureService(
      customers as never,
      media as never,
      proofs as never,
      analysis as never,
    );

    const outcome = await service.tryCapture(imageEvent({ messageId: 'wamid.proof.1' }));

    expect(outcome).toBe('captured');
    expect(customers.findOrCreate).toHaveBeenCalledWith({ phone: '59170000000' });
    expect(media.resolve).toHaveBeenCalledWith(imageEvent().image);
    expect(proofs.intake).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'customer-1',
        sourceMessageId: 'wamid.proof.1',
        mimeType: 'image/jpeg',
      }),
    );
    expect(analysis.analyze).toHaveBeenCalledWith(
      expect.objectContaining({ proofId: 'proof-1', orderId: 'order-1', mimeType: 'image/jpeg' }),
    );
  });

  it('media privada resuelta correctamente: los bytes van en base64 al intake, nunca una URL', async () => {
    const media = fakeMedia({
      resolve: jest
        .fn()
        .mockResolvedValue({ ok: true, bytes: Buffer.from('abc'), mimeType: 'image/png' }),
    });
    const proofs = fakeProofs();
    const service = new PaymentProofCaptureService(
      fakeCustomers() as never,
      media as never,
      proofs as never,
      fakeAnalysis() as never,
    );

    await service.tryCapture(imageEvent());

    expect(proofs.intake).toHaveBeenCalledWith(
      expect.objectContaining({
        fileBase64: Buffer.from('abc').toString('base64'),
        mimeType: 'image/png',
      }),
    );
  });

  it('si la media no se puede resolver, se trata como imagen normal en vez de fallar en silencio', async () => {
    const media = fakeMedia({
      resolve: jest.fn().mockResolvedValue({ ok: false, reason: 'blocked_url' }),
    });
    const proofs = fakeProofs();
    const service = new PaymentProofCaptureService(
      fakeCustomers() as never,
      media as never,
      proofs as never,
      fakeAnalysis() as never,
    );

    const outcome = await service.tryCapture(imageEvent());

    expect(outcome).toBe('not_a_proof');
    expect(proofs.intake).not.toHaveBeenCalled();
  });

  it('capture_status distinto de "stored" (falló el guardado) queda capturado igual, pero NO se analiza', async () => {
    const proofs = fakeProofs({
      intake: jest.fn().mockResolvedValue({
        id: 'proof-2',
        orderId: 'order-1',
        customerId: 'customer-1',
        attemptId: null,
        matchMethod: 'single_open_qr_order',
        routingException: null,
        captureStatus: 'failed',
        candidateCount: 1,
        createdAt: new Date().toISOString(),
      }),
    });
    const analysis = fakeAnalysis();
    const service = new PaymentProofCaptureService(
      fakeCustomers() as never,
      fakeMedia() as never,
      proofs as never,
      analysis as never,
    );

    const outcome = await service.tryCapture(imageEvent());

    expect(outcome).toBe('captured');
    expect(analysis.analyze).not.toHaveBeenCalled();
  });

  it('un fallo del análisis (lanza) no impide reportar la captura como exitosa (no corrompe el estado de pago)', async () => {
    const analysis = { analyze: jest.fn().mockRejectedValue(new Error('vision down')) };
    const service = new PaymentProofCaptureService(
      fakeCustomers() as never,
      fakeMedia() as never,
      fakeProofs() as never,
      analysis as never,
    );

    const outcome = await service.tryCapture(imageEvent());

    expect(outcome).toBe('captured');
  });

  it('un mensaje de imagen sin WAMID se salta: no hay clave de idempotencia con la que capturar', async () => {
    const customers = fakeCustomers();
    const proofs = fakeProofs();
    const service = new PaymentProofCaptureService(
      customers as never,
      fakeMedia() as never,
      proofs as never,
      fakeAnalysis() as never,
    );

    const outcome = await service.tryCapture(imageEvent({ messageId: null }));

    expect(outcome).toBe('skipped');
    expect(proofs.intake).not.toHaveBeenCalled();
  });
});
