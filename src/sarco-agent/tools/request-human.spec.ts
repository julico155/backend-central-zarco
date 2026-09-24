import { createRequestHumanAction } from './request-human';
import { executeToolCall } from './registry';

describe('createRequestHumanAction (tool directa)', () => {
  it('cuando el puerto deriva, confirma el efecto visible y pide silencio tras la respuesta', async () => {
    const escalate = jest.fn().mockResolvedValue({ handed: true });
    const tool = createRequestHumanAction({ escalate });

    const executed = await executeToolCall(
      { callId: 'call-1', name: 'request_human', arguments: '{}' },
      [tool],
      {
        customerPhone: '59170000000',
        sourceMessageId: 'wamid.1',
        phoneNumberId: 'phone-1',
        inboundText: 'quiero reclamar',
      },
    );

    expect(escalate).toHaveBeenCalledWith({
      customerPhone: '59170000000',
      sourceMessageId: 'wamid.1',
      inboundText: 'quiero reclamar',
    });
    expect(executed.ok).toBe(true);
    expect(executed.userVisibleEffectConfirmed).toBe(true);
    expect(executed.silenceAfterReply).toBe(false);
    expect(JSON.parse(executed.output)).toEqual({ handed: true });
  });

  it('cuando el puerto NO deriva (sin motivo), no confirma efecto y pide silencio tras la respuesta', async () => {
    const escalate = jest.fn().mockResolvedValue({ handed: false });
    const tool = createRequestHumanAction({ escalate });

    const executed = await executeToolCall(
      { callId: 'call-1', name: 'request_human', arguments: '{}' },
      [tool],
      {
        customerPhone: '59170000000',
        sourceMessageId: 'wamid.1',
        phoneNumberId: null,
        inboundText: 'gracias',
      },
    );

    expect(executed.userVisibleEffectConfirmed).toBe(false);
    expect(executed.silenceAfterReply).toBe(true);
  });

  it('la herramienta declara que produce efecto visible y que ese efecto completa el turno', () => {
    const tool = createRequestHumanAction({ escalate: jest.fn() });
    expect(tool.producesUserVisibleEffect).toBe(true);
    expect(tool.effectCompletesTurn).toBe(true);
  });
});
