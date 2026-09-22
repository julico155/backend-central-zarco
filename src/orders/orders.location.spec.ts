import { validate } from 'class-validator';
import { OrdersService } from './orders.service';
import { AttachLocationDto } from './dto/attach-location.dto';

describe('OrdersService.attachLocation', () => {
  it('persists coordinates and structured dropoff address together', async () => {
    const set = jest.fn();
    const update = {
      set: (value: unknown) => {
        set(value);
        return update;
      },
      where: () => update,
      execute: jest.fn(),
    };
    const database = {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: async () => ({ id: 'order-a', delivery_type: 'delivery' }),
          }),
        }),
      }),
      updateTable: () => update,
    };
    const quoteForOrder = jest.fn().mockResolvedValue(undefined);
    const service = new OrdersService(
      database as never,
      {} as never,
      {} as never,
      { quoteForOrder } as never,
      {} as never,
      {} as never,
    );
    jest.spyOn(service, 'findById').mockResolvedValue({ id: 'order-a' } as never);

    await service.attachLocation('order-a', {
      latitude: -17.78,
      longitude: -63.18,
      dropoffAddress: 'Av. Siempre Viva 123',
    });

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery_latitude: -17.78,
        delivery_longitude: -63.18,
        dropoff_address: 'Av. Siempre Viva 123',
      }),
    );
    expect(quoteForOrder).toHaveBeenCalledWith('order-a');
  });

  it('rejects an empty dropoff address at DTO validation', async () => {
    const dto = Object.assign(new AttachLocationDto(), {
      latitude: -17.78,
      longitude: -63.18,
      dropoffAddress: '',
    });

    expect(await validate(dto)).not.toHaveLength(0);
  });
});
