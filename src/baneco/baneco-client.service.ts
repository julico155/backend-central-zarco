import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';

export interface GenerateQrParams {
  transactionId: string;
  amount: number;
  description: string;
  /** Formato YYYY-MM-DD — es el único nivel de granularidad que acepta el banco. */
  dueDate: string;
}

export interface GenerateQrResult {
  qrId: string;
  qrImageBase64: string;
  raw: unknown;
}

export type StatusQrCode = 0 | 1 | 9;

export interface StatusQrResult {
  statusQrCode: StatusQrCode;
  raw: unknown;
}

/**
 * Cliente HTTP de la API QR de Banco Económico (ver
 * `Manual_Integracion_API_QR_Banco_Economico_Smarky.pdf`, validado en
 * certificación). El banco no documenta expiración de token — la estrategia
 * es cachear en memoria del proceso y reautenticar una vez ante un 401.
 */
@Injectable()
export class BanecoClientService {
  private readonly logger = new Logger(BanecoClientService.name);
  private cachedToken: string | null = null;
  private cachedEncryptedAccount: string | null = null;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async generateQR(params: GenerateQrParams): Promise<GenerateQrResult> {
    const accountCredit = await this.getEncryptedAccount();
    const raw = await this.authenticatedRequest<{
      qrId: string;
      qrImage: string;
      responseCode: number;
      message: string;
    }>('POST', '/api/qrsimple/generateQR', {
      transactionId: params.transactionId,
      accountCredit,
      currency: 'BOB',
      amount: params.amount,
      description: params.description,
      dueDate: params.dueDate,
      singleUse: true,
      modifyAmount: false,
    });
    if (raw.responseCode !== 0 || !raw.qrId) {
      throw new Error(`generateQR falló: responseCode=${raw.responseCode} message=${raw.message}`);
    }
    return { qrId: raw.qrId, qrImageBase64: raw.qrImage, raw };
  }

  async statusQR(qrId: string): Promise<StatusQrResult> {
    const raw = await this.authenticatedRequest<{
      statusQrCode: StatusQrCode;
      responseCode: number;
      message: string;
    }>('GET', '/api/qrsimple/statusQR', { qrId });
    return { statusQrCode: raw.statusQrCode, raw };
  }

  async cancelQR(qrId: string): Promise<void> {
    await this.authenticatedRequest('DELETE', '/api/qrsimple/cancelQR', { qrId });
  }

  private async getEncryptedAccount(): Promise<string> {
    if (this.cachedEncryptedAccount) return this.cachedEncryptedAccount;
    const { aesKey, account } = this.config.get('baneco', { infer: true });
    this.cachedEncryptedAccount = await this.encrypt(account, aesKey);
    return this.cachedEncryptedAccount;
  }

  private async encrypt(text: string, aesKey: string): Promise<string> {
    const { baseUrl } = this.config.get('baneco', { infer: true });
    const url = new URL(`${baseUrl}/api/authentication/encrypt`);
    url.searchParams.set('text', text);
    url.searchParams.set('aesKey', aesKey);
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`Baneco /encrypt falló: HTTP ${response.status}`);
    }
    return (await response.json()) as string;
  }

  private async authenticate(): Promise<string> {
    const { baseUrl, username, password, aesKey } = this.config.get('baneco', { infer: true });
    const encryptedPassword = await this.encrypt(password, aesKey);
    const response = await fetch(`${baseUrl}/api/authentication/authenticate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userName: username, password: encryptedPassword }),
    });
    if (!response.ok) {
      throw new Error(`Baneco /authenticate falló: HTTP ${response.status}`);
    }
    const body = (await response.json()) as { token: string; responseCode: number; message: string };
    if (body.responseCode !== 0 || !body.token) {
      throw new Error(`Baneco /authenticate rechazado: ${body.message}`);
    }
    this.cachedToken = body.token;
    return body.token;
  }

  /** GET manda el body igual que POST/DELETE — así lo validó el manual contra el sandbox del banco. */
  private async authenticatedRequest<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
  ): Promise<T> {
    const { baseUrl } = this.config.get('baneco', { infer: true });
    const token = this.cachedToken ?? (await this.authenticate());

    const doRequest = async (bearer: string) =>
      fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify(body),
      });

    let response = await doRequest(token);
    if (response.status === 401) {
      this.logger.warn(`Baneco ${method} ${path} -> 401, reautenticando`);
      const freshToken = await this.authenticate();
      response = await doRequest(freshToken);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.logger.warn(`Baneco ${method} ${path} -> ${response.status} ${text}`);
      throw new Error(`Baneco ${method} ${path} -> HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
}
