export type WebhookEventStatus = 'received' | 'processing' | 'processed' | 'failed';

export interface WebhookEventRow {
  id: string;
  event_name: string;
  event_id: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  claim_token: string;
}

export interface WebhookDispatchEvent {
  id: string;
  eventId: string;
  eventName: string;
  payload: unknown;
  /** Parsed again from the durable payload at claim time; never trusted before HMAC. */
  normalizedEvents: NormalizedKapsoEvent[];
}

export interface WebhookDispatchPort {
  dispatch(event: WebhookDispatchEvent): Promise<void>;
}

export type WebhookAcceptResult =
  { kind: 'accepted'; id: string } | { kind: 'duplicate' } | { kind: 'in_progress' };
import { NormalizedKapsoEvent } from '../kapso/kapso.types';
