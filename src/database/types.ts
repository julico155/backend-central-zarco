import { ColumnType, Generated, JSONColumnType } from 'kysely';

/**
 * Tipos de tabla para Kysely. Nombres de columna en snake_case (tal como
 * están en la base) — no se usa el plugin de camelCase para que el SQL
 * crudo y el query builder hablen del mismo nombre siempre.
 *
 * Timestamp y los JSON con default ya declaran su lado de INSERT como
 * opcional dentro del propio ColumnType — a diferencia de columnas planas,
 * NO se envuelven en `Generated<>` (anidar Generated<ColumnType<...>> hace
 * que TS deje de reducir el tipo correctamente en `.set()`/`.values()`).
 */

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type OptionalJsonArray<T> = ColumnType<T, T | string | undefined, T | string>;

export interface CategoriesTable {
  id: Generated<string>;
  name: string;
  sort_order: Generated<number>;
  is_active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ProductsTable {
  id: Generated<string>;
  code: string;
  name: string;
  category_id: string;
  price: string; // numeric(10,2) llega como string del driver pg
  is_active: Generated<boolean>;
  is_available: Generated<boolean>;
  sort_order: Generated<number>;
  image_key: string | null;
  image_mime_type: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CustomersTable {
  id: Generated<string>;
  name: string | null;
  phone: string | null;
  email: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface IdempotencyKeysTable {
  id: Generated<string>;
  api_client: string;
  endpoint: string;
  idempotency_key: string;
  request_hash: string;
  response_status: number | null;
  response_body: JSONColumnType<Record<string, unknown>> | null;
  created_at: Timestamp;
  completed_at: Timestamp | null;
}

export type OrderChannel = 'whatsapp' | 'web' | 'pos';
export type OrderDeliveryType = 'delivery' | 'pickup';
export type OrderPaymentMethod = 'qr' | 'cash' | 'card';
export type OrderPaymentStatus = 'unpaid' | 'pending_review' | 'paid' | 'rejected';
export type OrderStatus =
  | 'draft'
  | 'awaiting_location'
  | 'confirmed'
  | 'preparing'
  | 'ready'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled';
export type DeliveryQuoteStatus = 'pending' | 'quoted' | 'pending_manual' | 'failed';

export interface OrdersTable {
  id: Generated<string>;
  order_number: Generated<string>;
  customer_id: string | null;
  channel: OrderChannel;
  customer_name: string;
  delivery_type: OrderDeliveryType;
  payment_method: OrderPaymentMethod;
  payment_status: Generated<OrderPaymentStatus>;
  notes: string | null;
  status: Generated<OrderStatus>;
  subtotal_amount: string;
  delivery_base_amount: Generated<string>;
  delivery_surcharge_amount: Generated<string>;
  total_amount: string;
  delivery_pricing: 'dynamic' | null;
  delivery_quote_status: DeliveryQuoteStatus | null;
  delivery_distance_meters: number | null;
  delivery_latitude: number | null;
  delivery_longitude: number | null;
  delivery_fee_paid: Generated<boolean>;
  cash_confirmed_at: Timestamp | null;
  confirmed_at: Timestamp | null;
  status_updated_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface OrderItemsTable {
  id: Generated<string>;
  order_id: string;
  product_id: string;
  product_code_snapshot: string;
  product_name_snapshot: string;
  unit_price_snapshot: string;
  quantity: number;
  subtotal: string;
  created_at: Timestamp;
}

export type LateOrderRequestStatus = 'pending' | 'accepted' | 'rejected' | 'expired';

export interface LateOrderRequestsTable {
  id: Generated<string>;
  request_number: Generated<string>;
  customer_id: string | null;
  customer_name: string;
  channel: OrderChannel;
  delivery_type: OrderDeliveryType;
  payment_method: OrderPaymentMethod;
  notes: string | null;
  items_json: JSONColumnType<unknown[]>;
  promotions_json: OptionalJsonArray<unknown[]>;
  subtotal_amount: string;
  idempotency_key: string;
  status: Generated<LateOrderRequestStatus>;
  requested_at: Timestamp;
  expires_at: Timestamp;
  decided_at: Timestamp | null;
  decided_by: string | null;
  order_id: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DeliveryTariffBandsTable {
  band_index: number;
  max_distance_meters: number;
  fee_amount: string;
}

export type DeliveryQuoteRequestStatus = 'quoted' | 'manual_quote' | 'failed';

export interface DeliveryQuoteRequestsTable {
  id: Generated<string>;
  customer_id: string | null;
  idempotency_key: string;
  latitude: number;
  longitude: number;
  status: DeliveryQuoteRequestStatus;
  distance_meters: number | null;
  distance_source: 'mapbox' | 'straight_line' | 'reused' | null;
  fee_amount: string | null;
  error_code: string | null;
  created_at: Timestamp;
}

export type PaymentAttemptReviewStatus = 'pending_review' | 'accepted' | 'rejected';

export interface PaymentAttemptsTable {
  id: Generated<string>;
  order_id: string;
  customer_id: string | null;
  opened_at: Timestamp;
  opened_as: Generated<'normal' | 'late'>;
  review_status: Generated<PaymentAttemptReviewStatus>;
  reviewed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type PaymentProofMatchMethod =
  | 'reply_to_qr'
  | 'single_open_qr_order'
  | 'current_qr_order'
  | 'attached'
  | 'duplicate'
  | 'ambiguous'
  | 'manual'
  | 'unresolved';
export type PaymentProofRoutingException =
  'signal_conflict' | 'expired_target' | 'payment_already_accepted' | 'closed_order';
export type PaymentProofCaptureStatus = 'capturing' | 'stored' | 'failed';
export type PaymentProofAnalysisStatus = 'pending' | 'ok' | 'failed';
export type PaymentProofAnalysisVerdict = 'ok' | 'suspicious' | 'unreadable';

export interface PaymentProofsTable {
  id: Generated<string>;
  order_id: string | null;
  customer_id: string | null;
  attempt_id: string | null;
  duplicate_of_id: string | null;
  source_message_id: string;
  match_method: PaymentProofMatchMethod;
  routing_exception: PaymentProofRoutingException | null;
  capture_status: Generated<PaymentProofCaptureStatus>;
  capture_attempts: Generated<number>;
  storage_provider: Generated<string>;
  storage_key: string | null;
  mime_type: string;
  byte_size: number | null;
  sha256_hex: string | null;
  analysis_status: Generated<PaymentProofAnalysisStatus>;
  analysis_verdict: PaymentProofAnalysisVerdict | null;
  analysis_reasons: string[] | null;
  analysis_amount_label: string | null;
  candidate_count: number | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface PromotionsTable {
  id: Generated<string>;
  name: string;
  description: string | null;
  promo_price: string;
  is_active: Generated<boolean>;
  starts_at: Timestamp | null;
  ends_at: Timestamp | null;
  sort_order: Generated<number>;
  image_url: string | null;
  archived_at: Timestamp | null;
  revision: Generated<number>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface PromotionItemsTable {
  id: Generated<string>;
  promotion_id: string;
  product_id: string;
  quantity: number;
}

/** Componentes del combo congelados al momento de la venta, no un join en vivo con products. */
export interface OrderPromotionComponentSnapshot {
  productId: string;
  code: string;
  name: string;
  unitPrice: number;
  quantity: number;
}

export interface OrderPromotionsTable {
  id: Generated<string>;
  order_id: string;
  promotion_id: string | null;
  promotion_name_snapshot: string;
  promo_price_snapshot: string;
  combo_quantity: number;
  subtotal: string;
  components_snapshot: JSONColumnType<OrderPromotionComponentSnapshot[]>;
}

export interface OperationalSettingsTable {
  id: true;
  rain_surcharge_enabled: Generated<boolean>;
  rain_surcharge_amount: Generated<string>;
  business_opens_hour: Generated<number>;
  business_closes_hour: Generated<number>;
  late_review_closes_hour: Generated<number>;
  restaurant_latitude: number | null;
  restaurant_longitude: number | null;
  updated_at: Timestamp;
}

export type DashboardUserRole = 'admin' | 'kitchen' | 'cashier';

export interface DashboardUsersTable {
  id: Generated<string>;
  username: string;
  password_hash: string;
  role: DashboardUserRole;
  is_active: Generated<boolean>;
  created_at: Timestamp;
}

export type NotificationJobChannel = 'whatsapp' | 'telegram';
export type NotificationJobStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface NotificationJobsTable {
  id: Generated<string>;
  kind: string;
  channel: NotificationJobChannel;
  target_ref: string;
  payload: JSONColumnType<Record<string, unknown>>;
  status: Generated<NotificationJobStatus>;
  claim_token: string | null;
  claimed_until: Timestamp | null;
  attempts: Generated<number>;
  next_attempt_at: Timestamp | null;
  external_message_id: string | null;
  last_error_code: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Database {
  categories: CategoriesTable;
  products: ProductsTable;
  customers: CustomersTable;
  idempotency_keys: IdempotencyKeysTable;
  orders: OrdersTable;
  order_items: OrderItemsTable;
  late_order_requests: LateOrderRequestsTable;
  delivery_tariff_bands: DeliveryTariffBandsTable;
  delivery_quote_requests: DeliveryQuoteRequestsTable;
  payment_attempts: PaymentAttemptsTable;
  payment_proofs: PaymentProofsTable;
  promotions: PromotionsTable;
  promotion_items: PromotionItemsTable;
  order_promotions: OrderPromotionsTable;
  operational_settings: OperationalSettingsTable;
  dashboard_users: DashboardUsersTable;
  notification_jobs: NotificationJobsTable;
}
