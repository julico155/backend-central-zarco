import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WebhookInboxService } from './webhook-inbox.service';

@Injectable()
export class WebhookInboxCron {
  private readonly logger = new Logger(WebhookInboxCron.name);

  constructor(private readonly inbox: WebhookInboxService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    const result = await this.inbox.recoverDue();
    if (result.claimed > 0) this.logger.log(`Recuperados ${result.claimed} webhook_events.`);
  }
}
