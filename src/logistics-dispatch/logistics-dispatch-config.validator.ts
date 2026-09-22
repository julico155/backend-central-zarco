import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';

@Injectable()
export class LogisticsDispatchConfigValidator implements OnModuleInit {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  onModuleInit(): void {
    const logistics = this.config.get('logisticsDispatch', { infer: true });
    if (!logistics.enabled) return;

    const missing = [
      ['LOGISTICS_BASE_URL', logistics.baseUrl],
      ['LOGISTICS_API_TOKEN', logistics.apiToken],
      ['LOGISTICS_TENANT_ID', logistics.tenantId],
      ['LOGISTICS_RESTAURANT_ID', logistics.restaurantId],
      ['LOGISTICS_BRANCH_ID', logistics.branchId],
    ]
      .filter(([, value]) => !value.trim())
      .map(([name]) => name);

    if (missing.length > 0) {
      throw new Error(`Missing required Logistics configuration: ${missing.join(', ')}`);
    }
    if (!Number.isInteger(logistics.requestTimeoutMs) || logistics.requestTimeoutMs <= 0) {
      throw new Error('LOGISTICS_REQUEST_TIMEOUT_MS must be a positive integer');
    }
  }
}
