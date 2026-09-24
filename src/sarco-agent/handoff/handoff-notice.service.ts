import { Injectable, Logger } from '@nestjs/common';
import { NotificationsOutService } from '../../notifications-out/notifications-out.service';
import { buildHandoffNotice, type HandoffNoticeInput } from './handoff-notice';

export type HandoffNotifier = (input: HandoffNoticeInput) => Promise<void>;

/**
 * Avisa al equipo (Telegram, chat de atención humana — NO el grupo de motos)
 * que una conversación necesita a una persona. Va por `notification_jobs`
 * (`handoff_notice`, targetRef = teléfono: dos detecciones sobre el mismo
 * cliente dan un solo aviso, igual que sarcoRestaurant). Nunca lanza: el
 * cliente ya está esperando a una persona con o sin aviso.
 */
@Injectable()
export class HandoffNoticeService {
  private readonly logger = new Logger(HandoffNoticeService.name);

  constructor(private readonly notifications: NotificationsOutService) {}

  readonly notify: HandoffNotifier = async (input) => {
    try {
      await this.notifications.notifyNow({
        channel: 'telegram',
        kind: 'handoff_notice',
        targetRef: input.customerPhone,
        payload: { chatRef: 'handoff-group', text: buildHandoffNotice(input) },
      });
    } catch (error) {
      this.logger.error(`handoff_notice_error ${(error as Error).name}`);
    }
  };
}
