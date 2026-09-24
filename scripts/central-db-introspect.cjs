#!/usr/bin/env node
/**
 * Introspección ESTRICTAMENTE DE SOLO LECTURA de la DB CENTRAL (DATABASE_URL).
 *
 *   node scripts/central-db-introspect.cjs --out central-schema-report.txt
 *
 * (`--out` escribe el archivo en UTF-8; con `>` de PowerShell queda en UTF-16.)
 *
 * - Lee la conexión de DATABASE_URL. Nunca imprime la URL, el host ni
 *   credenciales (los errores de conexión solo muestran el código).
 * - Todo corre dentro de `BEGIN READ ONLY` y termina en `ROLLBACK`: Postgres
 *   rechaza cualquier escritura. Solo hay SELECT sobre catálogos y conteos
 *   agregados (por estado / por tipo). No lee filas de negocio, clientes,
 *   teléfonos, notas, payloads ni montos.
 * - No ejecuta migraciones y no crea `pgmigrations` ni ninguna otra cosa.
 * - Compara el esquema real contra `src/database/types.ts` (lo que el código
 *   actual espera) y contra lo que esperan las migraciones 034 y 035.
 */
const fs = require('node:fs');
const path = require('node:path');

let Client;
try {
  ({ Client } = require('pg'));
} catch {
  ({ Client } = require(path.join(__dirname, '..', 'node_modules', 'pg')));
}

const ROOT = path.join(__dirname, '..');

/** Tablas con detalle completo (constraints, índices, FK, triggers). */
const DETAIL_TABLES = [
  'notification_jobs',
  'orders',
  'order_items',
  'order_promotions',
  'payment_attempts',
  'payment_proofs',
  'bank_qr_charges',
  'customers',
  'delivery_quote_requests',
  'idempotency_keys',
  'cash_register_sessions',
  'operational_settings',
  'delivery_tariff_bands',
  'late_order_requests',
];

// Sin base de datos: solo muestra lo que el código espera (para verificar el parseo).
if (process.argv.includes('--print-expected')) {
  const expectedOnly = parseExpectedSchema();
  for (const [table, columns] of Object.entries(expectedOnly)) {
    console.log(`${table}: ${Object.entries(columns).map(([n, c]) => n + (c.nullable ? '?' : '')).join(', ')}`);
  }
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL no está definida en este proceso.');
  process.exit(2);
}
if (process.env.AGENT_DATABASE_URL && process.env.AGENT_DATABASE_URL === url) {
  console.error('DATABASE_URL es igual a AGENT_DATABASE_URL: se aborta por seguridad.');
  process.exit(3);
}

const outIndex = process.argv.indexOf('--out');
const outFile = outIndex > -1 ? process.argv[outIndex + 1] : null;
const lines = [];
const out = (line = '') => {
  lines.push(line);
  if (!outFile) process.stdout.write(line + '\n');
};
const section = (title) => out(`\n=== ${title} ===`);

/** Lo que el código espera: parsea las tablas de `Database` en src/database/types.ts. */
function parseExpectedSchema() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'database', 'types.ts'), 'utf8').replace(/\r\n/g, '\n');
  const interfaces = {};
  for (const m of src.matchAll(/export interface (\w+) \{\n([\s\S]*?)\n\}/g)) {
    interfaces[m[1]] = m[2];
  }
  const dbBody = interfaces.Database;
  if (!dbBody) throw new Error('no se encontró la interfaz Database');
  const expected = {};
  for (const m of dbBody.matchAll(/^ {2}(\w+): (\w+);$/gm)) {
    const body = interfaces[m[2]];
    if (!body) continue;
    const columns = {};
    for (const c of body.matchAll(/^ {2}(\w+)(\?)?: (.+?);(?: *\/\/.*)?$/gm)) {
      const type = c[3];
      columns[c[1]] = {
        nullable: /\|\s*null\b/.test(type),
        generated: /^Generated</.test(type) || /\bundefined\b/.test(type),
      };
    }
    expected[m[1]] = columns;
  }
  return expected;
}

async function main() {
  const expected = parseExpectedSchema();
  const expectedTables = Object.keys(expected).filter((t) => /^[a-z_]+$/.test(t));

  const client = new Client({ connectionString: url, statement_timeout: 30000 });
  try {
    await client.connect();
  } catch (error) {
    console.error(`No se pudo conectar (código: ${error && error.code ? error.code : 'desconocido'}).`);
    process.exit(4);
  }

  try {
    await client.query('BEGIN READ ONLY');
    const q = async (text, params) => (await client.query(text, params)).rows;
    let sp = 0;
    /** Consulta tolerante a errores (savepoint): un fallo no aborta el resto del reporte. */
    const tryQ = async (label, text, params) => {
      const name = `sp_${(sp += 1)}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        const rows = await q(text, params);
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return rows;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        out(`  (${label}: no disponible — ${error && error.code ? error.code : 'error'})`);
        return null;
      }
    };

    const [{ ro }] = await q("select current_setting('transaction_read_only') as ro");
    out(`transaction_read_only = ${ro}`);
    if (ro !== 'on') throw new Error('la transacción no quedó en solo lectura');

    section('server');
    const [v] = await q("select current_setting('server_version') as version");
    out(`postgres ${v.version}`);

    section('tablas en schema public (solo nombres)');
    const tables = (
      await q(
        "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
      )
    ).map((t) => t.table_name);
    out(tables.join(', ') || '(ninguna)');

    section('pgmigrations — migraciones registradas');
    const [{ pgm }] = await q("select to_regclass('public.pgmigrations') is not null as pgm");
    out(`existe public.pgmigrations: ${pgm}`);
    const repoFiles = fs
      .readdirSync(path.join(ROOT, 'migrations'))
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort();
    if (pgm) {
      const registered = await q('select name, run_on from public.pgmigrations order by id');
      out(`registradas: ${registered.length}`);
      for (const r of registered) out(`  ${r.name} | ${new Date(r.run_on).toISOString()}`);
      const names = new Set(registered.map((r) => r.name));
      const pendientes = repoFiles.filter((f) => !names.has(f));
      const sinArchivo = registered.map((r) => r.name).filter((n) => !repoFiles.includes(n));
      out(`en el repo y NO registradas (pendientes): ${pendientes.join(', ') || '(ninguna)'}`);
      out(`registradas SIN archivo en migrations/: ${sinArchivo.join(', ') || '(ninguna)'}`);
      // node-pg-migrate (checkOrder) exige que lo registrado sea un prefijo del orden de archivos.
      const firstPending = repoFiles.findIndex((f) => !names.has(f));
      const registeredAfterPending =
        firstPending === -1 ? [] : repoFiles.slice(firstPending).filter((f) => names.has(f));
      out(`registradas DESPUÉS de una pendiente (rompería checkOrder): ${registeredAfterPending.join(', ') || '(ninguna)'}`);
    } else {
      out('(sin tabla pgmigrations: node-pg-migrate no ha corrido nunca contra esta base)');
      out(`archivos en migrations/: ${repoFiles.length} (${repoFiles[0]} … ${repoFiles[repoFiles.length - 1]})`);
    }

    section('rol de conexión (solo banderas, sin nombres)');
    const [role] = await q('select rolsuper, rolbypassrls from pg_roles where rolname = current_user');
    out(`superuser=${role.rolsuper} bypassrls=${role.rolbypassrls}`);
    for (const t of DETAIL_TABLES) {
      const [p] = await q(
        `select to_regclass($1) is not null as existe,
                coalesce(has_table_privilege(current_user, to_regclass($1), 'SELECT'), false) as sel,
                coalesce(has_table_privilege(current_user, to_regclass($1), 'INSERT'), false) as ins,
                coalesce(has_table_privilege(current_user, to_regclass($1), 'UPDATE'), false) as upd,
                coalesce(has_table_privilege(current_user, to_regclass($1), 'DELETE'), false) as del,
                coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass($1)), false) as rls,
                coalesce((select pg_has_role(current_user, c.relowner, 'USAGE') from pg_class c where c.oid = to_regclass($1)), false) as owner_role`,
        [`public.${t}`],
      );
      out(
        `${t}: existe=${p.existe} select=${p.sel} insert=${p.ins} update=${p.upd} delete=${p.del} rol_dueño=${p.owner_role} rls=${p.rls}`,
      );
    }

    // ── Columnas de TODAS las tablas que el código conoce ────────────────
    section('columnas (todas las tablas de src/database/types.ts)');
    const cols = await q(
      `select table_name, column_name, data_type, udt_name, is_nullable, column_default, is_identity
         from information_schema.columns
        where table_schema = 'public' and table_name = any($1)
        order by table_name, ordinal_position`,
      [expectedTables],
    );
    for (const t of expectedTables) {
      out(`\n[${t}]`);
      const rows = cols.filter((c) => c.table_name === t);
      if (rows.length === 0) out('  (la tabla NO existe)');
      for (const c of rows) {
        out(
          `  ${c.column_name} ${c.udt_name === c.data_type ? c.data_type : c.data_type + '/' + c.udt_name} ${
            c.is_nullable === 'NO' ? 'NOT NULL' : 'null'
          }${c.column_default ? ' default ' + c.column_default : ''}${c.is_identity === 'YES' ? ' identity' : ''}`,
        );
      }
    }

    // ── Comparación contra lo que el código espera ───────────────────────
    section('compatibilidad con el código actual (src/database/types.ts)');
    let issues = 0;
    const flag = (msg) => {
      issues += 1;
      out(`  ✗ ${msg}`);
    };
    for (const t of expectedTables) {
      const real = cols.filter((c) => c.table_name === t);
      if (real.length === 0) {
        flag(`${t}: la tabla NO existe en la DB`);
        continue;
      }
      const realByName = new Map(real.map((c) => [c.column_name, c]));
      for (const [name, exp] of Object.entries(expected[t])) {
        const r = realByName.get(name);
        if (!r) {
          flag(`${t}.${name}: el código la espera y la DB NO la tiene`);
          continue;
        }
        if (exp.nullable && r.is_nullable === 'NO') {
          flag(`${t}.${name}: el código admite null y la DB es NOT NULL`);
        }
        if (!exp.nullable && r.is_nullable === 'YES') {
          out(`  · ${t}.${name}: el código la trata como NOT NULL y la DB admite null (informativo)`);
        }
        if (exp.generated && r.is_nullable === 'NO' && !r.column_default && r.is_identity !== 'YES') {
          flag(`${t}.${name}: el código la omite al insertar (default) y la DB no tiene default`);
        }
      }
      for (const c of real) {
        if (!(c.column_name in expected[t])) {
          out(`  · ${t}.${c.column_name}: existe en la DB y el código no la conoce (informativo)`);
        }
      }
    }
    for (const t of tables) {
      if (!expectedTables.includes(t) && t !== 'pgmigrations') {
        out(`  · tabla ${t}: existe en la DB y el código no la conoce (informativo)`);
      }
    }
    out(issues === 0 ? '  (sin incompatibilidades ✗)' : `  TOTAL incompatibilidades ✗: ${issues}`);

    // ── Migraciones 034 / 035 ────────────────────────────────────────────
    section('migraciones 034 y 035 — qué esperan y qué hay');
    const has = (t, c) => cols.some((x) => x.table_name === t && x.column_name === c);
    const constraintExists = async (table, name) =>
      (
        await q(
          'select 1 from pg_constraint where conrelid = to_regclass($1) and conname = $2',
          [`public.${table}`, name],
        )
      ).length > 0;
    const indexExists = async (name) =>
      (await q("select 1 from pg_indexes where schemaname = 'public' and indexname = $1", [name])).length > 0;

    out('034 (payment-proof-analysis):');
    for (const c of ['analysis_facts', 'analyzed_at', 'analysis_model']) {
      out(`  payment_proofs.${c}: ${has('payment_proofs', c) ? 'YA EXISTE' : 'falta (la crea 034)'}`);
    }
    for (const c of ['analysis_status', 'analysis_verdict', 'analysis_reasons', 'analysis_amount_label']) {
      out(`  payment_proofs.${c} (previa a 034): ${has('payment_proofs', c) ? 'existe' : 'FALTA'}`);
    }
    for (const n of ['payment_proofs_analysis_facts_is_object', 'payment_proofs_analysis_coherence']) {
      out(`  constraint ${n}: ${(await constraintExists('payment_proofs', n)) ? 'YA EXISTE' : 'falta (la crea 034)'}`);
    }
    out(
      `  índice idx_payment_proofs_analysis_reference: ${
        (await indexExists('idx_payment_proofs_analysis_reference')) ? 'YA EXISTE' : 'falta (lo crea 034)'
      }`,
    );

    out('035 (delivery_fee_paid triestado):');
    const dfp = cols.find((c) => c.table_name === 'orders' && c.column_name === 'delivery_fee_paid');
    out(
      `  orders.delivery_fee_paid: ${
        dfp
          ? `existe, ${dfp.is_nullable === 'NO' ? 'NOT NULL' : 'null'}${dfp.column_default ? ', default ' + dfp.column_default : ', sin default'}`
          : 'FALTA'
      }`,
    );
    out(`  orders.delivery_fee_paid_at: ${has('orders', 'delivery_fee_paid_at') ? 'YA EXISTE' : 'falta (la crea 035)'}`);
    out(
      `  constraint orders_delivery_fee_paid_coherence: ${
        (await constraintExists('orders', 'orders_delivery_fee_paid_coherence')) ? 'YA EXISTE' : 'falta (la crea 035)'
      }`,
    );

    // ── Constraints / FK / índices / triggers de las tablas relevantes ───
    const present = DETAIL_TABLES.filter((t) => tables.includes(t));
    section('constraints (PK, UNIQUE, FK, CHECK) — tablas relevantes');
    const cons = await q(
      `select c.conrelid::regclass::text as tabla, c.conname, c.contype, pg_get_constraintdef(c.oid) as def
         from pg_constraint c
        where c.conrelid::regclass::text = any($1)
        order by 1, 3, 2`,
      [present],
    );
    for (const c of cons) out(`${c.tabla} | ${c.contype} | ${c.conname} | ${c.def}`);

    section('claves foráneas (origen → destino, on delete)');
    const fks = await q(
      `select c.conrelid::regclass::text as origen, c.conname, n.nspname as schema_destino,
              c.confrelid::regclass::text as destino, c.confdeltype as on_delete, c.convalidated
         from pg_constraint c
         join pg_class rc on rc.oid = c.confrelid
         join pg_namespace n on n.oid = rc.relnamespace
        where c.contype = 'f' and c.conrelid::regclass::text = any($1)
        order by 1, 2`,
      [present],
    );
    for (const f of fks) {
      out(`${f.origen} -> ${f.schema_destino}.${f.destino} | ${f.conname} | on_delete=${f.on_delete} | validada=${f.convalidated}`);
    }
    if (fks.length === 0) out('(ninguna)');

    section('índices — tablas relevantes');
    const idx = await q(
      `select tablename, indexname, indexdef from pg_indexes
        where schemaname = 'public' and tablename = any($1) order by 1, 2`,
      [present],
    );
    for (const i of idx) out(`${i.tablename} | ${i.indexname} | ${i.indexdef}`);

    section('triggers — tablas relevantes');
    const trg = await q(
      `select event_object_table as tabla, trigger_name, action_timing, event_manipulation
         from information_schema.triggers
        where event_object_schema = 'public' and event_object_table = any($1)
        order by 1, 2`,
      [present],
    );
    for (const t of trg) out(`${t.tabla} | ${t.trigger_name} | ${t.action_timing} ${t.event_manipulation}`);
    if (trg.length === 0) out('(ninguno)');

    section('funciones en public (solo nombres)');
    const fns = await q(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' order by 1`,
    );
    for (const f of fns) out(`${f.proname}(${f.args})`);
    if (fns.length === 0) out('(ninguna)');

    // ── Conteos agregados (sin filas de negocio) ─────────────────────────
    section('conteos por tabla (solo agregados)');
    for (const t of expectedTables) {
      if (!tables.includes(t)) continue;
      const rows = await tryQ(`count ${t}`, `select count(*)::int as filas from "${t}"`);
      if (rows) out(`${t}: filas=${rows[0].filas}`);
    }

    const distribution = async (title, table, column, extraWhere = '') => {
      if (!has(table, column)) return;
      const rows = await tryQ(
        title,
        `select coalesce(${column}::text, '(null)') as valor, count(*)::int as filas
           from "${table}" ${extraWhere} group by 1 order by 1`,
      );
      if (!rows) return;
      out(`${title}:`);
      if (rows.length === 0) out('  (sin filas)');
      for (const r of rows) out(`  ${r.valor} = ${r.filas}`);
    };

    section('notification_jobs — estado real');
    if (tables.includes('notification_jobs')) {
      await distribution('por canal', 'notification_jobs', 'channel');
      await distribution('por estado', 'notification_jobs', 'status');
      await distribution('por kind', 'notification_jobs', 'kind');
      const agg = await tryQ(
        'notification_jobs agregados',
        `select count(*) filter (where attempts >= 8)::int as intentos_agotados,
                count(*) filter (where status = 'sending' and claimed_until is not null and claimed_until <= now())::int as sending_lease_vencido,
                count(*) filter (where status = 'sending' and claimed_until is null)::int as sending_sin_lease,
                count(*) filter (where status = 'sent' and external_message_id is null)::int as sent_sin_external_id,
                count(*) filter (where status in ('pending','failed') and (next_attempt_at is null or next_attempt_at <= now()))::int as pendientes_o_fallidos_vencidos,
                count(*) filter (
                  where attempts < 8 and (
                    (status in ('pending','failed') and (next_attempt_at is null or next_attempt_at <= now()))
                    or (status = 'sending' and claimed_until is not null and claimed_until <= now())
                  )
                )::int as recuperables_reales
           from notification_jobs`,
      );
      if (agg) for (const [k, val] of Object.entries(agg[0])) out(`${k} = ${val}`);
    } else {
      out('(notification_jobs no existe)');
    }

    section('orders — agregados');
    if (tables.includes('orders')) {
      await distribution('por payment_status', 'orders', 'payment_status');
      await distribution('por payment_method', 'orders', 'payment_method');
      await distribution('por delivery_type', 'orders', 'delivery_type');
      await distribution('por status', 'orders', 'status');
      await distribution('por delivery_quote_status', 'orders', 'delivery_quote_status');
      await distribution('por delivery_fee_paid (true/false/null)', 'orders', 'delivery_fee_paid');
      const cand = await tryQ(
        'candidatos a delivery_notice',
        `select count(*)::int as delivery_pagados_cotizados_con_ubicacion
           from orders
          where delivery_type = 'delivery' and payment_status = 'paid'
            and delivery_quote_status = 'quoted'
            and delivery_latitude is not null and delivery_longitude is not null`,
      );
      if (cand) out(`delivery pagados + cotizados + con ubicación = ${cand[0].delivery_pagados_cotizados_con_ubicacion}`);
    } else {
      out('(orders no existe)');
    }

    section('pagos y comprobantes — agregados');
    if (tables.includes('payment_attempts')) await distribution('payment_attempts por review_status', 'payment_attempts', 'review_status');
    if (tables.includes('payment_proofs')) {
      await distribution('payment_proofs por capture_status', 'payment_proofs', 'capture_status');
      await distribution('payment_proofs por analysis_status', 'payment_proofs', 'analysis_status');
      await distribution('payment_proofs por analysis_verdict', 'payment_proofs', 'analysis_verdict');
      await distribution('payment_proofs por analysis_amount_label', 'payment_proofs', 'analysis_amount_label');
    }
    if (tables.includes('bank_qr_charges')) await distribution('bank_qr_charges por status', 'bank_qr_charges', 'status');
    if (tables.includes('delivery_quote_requests')) {
      await distribution('delivery_quote_requests por status', 'delivery_quote_requests', 'status');
    }

    // ── Filas que podrían BLOQUEAR 034 / 035 ─────────────────────────────
    section('filas que podrían bloquear 034 / 035 (conteos)');
    if (has('payment_proofs', 'analysis_status') && has('payment_proofs', 'analysis_verdict')) {
      const b = await tryQ(
        '034 coherencia',
        `select count(*) filter (where analysis_status = 'ok')::int as con_analysis_ok,
                count(*) filter (where analysis_status in ('pending','failed') and analysis_verdict is not null)::int as pending_o_failed_con_veredicto
           from payment_proofs`,
      );
      if (b) {
        out(`034: payment_proofs con analysis_status='ok' = ${b[0].con_analysis_ok}`);
        out(`034: payment_proofs pending/failed con veredicto = ${b[0].pending_o_failed_con_veredicto}`);
        out(
          '  (payment_proofs_analysis_coherence exige que TODA fila ok tenga analyzed_at; la columna es nueva y quedaría en null: cualquier fila ok haría fallar 034.)',
        );
      }
    }
    if (has('orders', 'delivery_fee_paid')) {
      const b = await tryQ(
        '035 filas',
        `select count(*)::int as total,
                count(*) filter (where delivery_fee_paid = true)::int as con_true,
                count(*) filter (where delivery_fee_paid = false)::int as con_false,
                count(*) filter (where delivery_fee_paid is null)::int as con_null
           from orders`,
      );
      if (b) {
        out(`035: orders total = ${b[0].total}; delivery_fee_paid true = ${b[0].con_true}; false = ${b[0].con_false}; null = ${b[0].con_null}`);
        out('  (035 pasa false→null en TODAS las filas; una fila con true no tendría delivery_fee_paid_at y haría fallar el CHECK de coherencia.)');
      }
    }

    await client.query('ROLLBACK');
    out('\nFIN: solo SELECT ejecutados dentro de una transacción READ ONLY con ROLLBACK.');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // la conexión se cierra igual
    }
    console.error(
      `Error durante la introspección (código: ${error && error.code ? error.code : 'n/a'})${
        error && error.code ? '' : ': ' + String(error.message).slice(0, 160)
      }`,
    );
    process.exitCode = 5;
  } finally {
    await client.end().catch(() => undefined);
    if (outFile) {
      fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
      process.stdout.write(`Reporte escrito en ${outFile}\n`);
    }
  }
}

main().catch((error) => {
  console.error(`Error inesperado: ${String(error && error.message).slice(0, 160)}`);
  process.exit(1);
});
