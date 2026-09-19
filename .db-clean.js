require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');

    await client.query(`
      truncate table
        order_promotions, promotion_items, promotions,
        order_items, payment_proofs, payment_attempts, bank_qr_charges,
        late_order_requests, delivery_quote_requests,
        notification_jobs, idempotency_keys,
        orders, products, categories, customers, cash_register_sessions
      cascade
    `);

    await client.query(`alter sequence order_number_seq restart with 1`);
    await client.query(`alter sequence late_order_request_number_seq restart with 1`);

    await client.query(
      `delete from dashboard_users where username in ('smoketest_cod', 'test-cajero-auto')`,
    );

    await client.query('commit');
    console.log('limpieza aplicada.');
  } catch (e) {
    await client.query('rollback');
    console.error('rollback, no se aplico nada:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
