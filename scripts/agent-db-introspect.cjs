#!/usr/bin/env node
/**
 * Introspección ESTRICTAMENTE DE SOLO LECTURA de la DB Agente.
 *
 *   node scripts/agent-db-introspect.cjs --out agent-schema-report.txt
 *
 * (`--out` escribe el archivo en UTF-8; con `>` de PowerShell queda en UTF-16.)
 *
 * - Lee la conexión de AGENT_DATABASE_URL. Nunca imprime la URL, el host ni
 *   credenciales (los errores de conexión solo muestran el código).
 * - Todo corre dentro de `BEGIN READ ONLY` y termina en `ROLLBACK`: Postgres
 *   rechaza cualquier escritura. Solo hay SELECT sobre catálogos y conteos
 *   agregados de `webhook_events` (por estado). No lee filas de negocio,
 *   mensajes, teléfonos ni payloads.
 * - No crea `pgmigrations` ni ninguna otra cosa.
 */
const path = require('node:path');

let Client;
try {
  ({ Client } = require('pg'));
} catch {
  ({ Client } = require(path.join(__dirname, '..', 'node_modules', 'pg')));
}

const TABLES = [
  'webhook_events',
  'agent_conversations',
  'agent_messages',
  'agent_runs',
  'agent_control_events',
  'menu_sessions',
  'menu_send_deliveries',
];

const url = process.env.AGENT_DATABASE_URL;
if (!url) {
  console.error('AGENT_DATABASE_URL no está definida en este proceso.');
  process.exit(2);
}
if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) {
  console.error('AGENT_DATABASE_URL es igual a DATABASE_URL: se aborta por seguridad.');
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

async function main() {
  const client = new Client({ connectionString: url, statement_timeout: 20000 });
  try {
    await client.connect();
  } catch (error) {
    console.error(`No se pudo conectar (código: ${error && error.code ? error.code : 'desconocido'}).`);
    process.exit(4);
  }

  try {
    await client.query('BEGIN READ ONLY');
    const q = async (text, params) => (await client.query(text, params)).rows;

    const [{ ro }] = await q("select current_setting('transaction_read_only') as ro");
    out(`transaction_read_only = ${ro}`);
    if (ro !== 'on') throw new Error('la transacción no quedó en solo lectura');

    section('server');
    const [v] = await q("select current_setting('server_version') as version");
    out(`postgres ${v.version}`);

    section('tablas en schema public (solo nombres)');
    const tables = await q(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
    );
    out(tables.map((t) => t.table_name).join(', ') || '(ninguna)');
    const [{ pgm }] = await q("select to_regclass('public.pgmigrations') is not null as pgm");
    out(`existe public.pgmigrations: ${pgm}`);
    const [{ ord }] = await q("select to_regclass('public.orders') is not null as ord");
    out(`existe public.orders: ${ord}`);

    section('rol de conexión (solo banderas, sin nombres)');
    const [role] = await q(
      "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    );
    out(`superuser=${role.rolsuper} bypassrls=${role.rolbypassrls}`);
    for (const t of TABLES) {
      const [p] = await q(
        `select to_regclass($1) is not null as existe,
                coalesce(has_table_privilege(current_user, to_regclass($1), 'SELECT'), false) as sel,
                coalesce(has_table_privilege(current_user, to_regclass($1), 'INSERT'), false) as ins,
                coalesce(has_table_privilege(current_user, to_regclass($1), 'UPDATE'), false) as upd,
                coalesce(has_table_privilege(current_user, to_regclass($1), 'DELETE'), false) as del,
                coalesce((select pg_has_role(current_user, c.relowner, 'USAGE') from pg_class c where c.oid = to_regclass($1)), false) as owner_role,
                coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass($1)), false) as rls`,
        [`public.${t}`],
      );
      out(
        `${t}: existe=${p.existe} select=${p.sel} insert=${p.ins} update=${p.upd} delete=${p.del} rol_dueño=${p.owner_role} rls=${p.rls}`,
      );
    }

    section('columnas');
    const cols = await q(
      `select table_name, column_name, data_type, udt_name, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = any($1)
        order by table_name, ordinal_position`,
      [TABLES],
    );
    for (const t of TABLES) {
      out(`\n[${t}]`);
      const rows = cols.filter((c) => c.table_name === t);
      if (rows.length === 0) out('  (la tabla NO existe)');
      for (const c of rows) {
        out(
          `  ${c.column_name} ${c.udt_name === c.data_type ? c.data_type : c.data_type + '/' + c.udt_name} ${
            c.is_nullable === 'NO' ? 'NOT NULL' : 'null'
          }${c.column_default ? ' default ' + c.column_default : ''}`,
        );
      }
    }

    section('constraints (PK, UNIQUE, FK, CHECK)');
    const cons = await q(
      `select c.conrelid::regclass::text as tabla, c.conname, c.contype, pg_get_constraintdef(c.oid) as def
         from pg_constraint c
        where c.conrelid::regclass::text = any($1)
        order by 1, 3, 2`,
      [TABLES],
    );
    for (const c of cons) out(`${c.tabla} | ${c.contype} | ${c.conname} | ${c.def}`);

    section('claves foráneas: detalle (origen → destino, schema del destino, on delete)');
    const fks = await q(
      `select c.conrelid::regclass::text as origen, c.conname,
              n.nspname as schema_destino, c.confrelid::regclass::text as destino,
              c.confdeltype as on_delete, c.convalidated
         from pg_constraint c
         join pg_class rc on rc.oid = c.confrelid
         join pg_namespace n on n.oid = rc.relnamespace
        where c.contype = 'f'
          and (c.conrelid::regclass::text = any($1) or c.confrelid::regclass::text = any($1))
        order by 1, 2`,
      [TABLES],
    );
    for (const f of fks) {
      out(
        `${f.origen} -> ${f.schema_destino}.${f.destino} | ${f.conname} | on_delete=${f.on_delete} | validada=${f.convalidated}`,
      );
    }
    if (fks.length === 0) out('(ninguna)');

    section('índices');
    const idx = await q(
      `select tablename, indexname, indexdef from pg_indexes
        where schemaname = 'public' and tablename = any($1) order by 1, 2`,
      [TABLES],
    );
    for (const i of idx) out(`${i.tablename} | ${i.indexname} | ${i.indexdef}`);

    section('triggers');
    const trg = await q(
      `select event_object_table as tabla, trigger_name, action_timing, event_manipulation
         from information_schema.triggers
        where event_object_schema = 'public' and event_object_table = any($1)
        order by 1, 2`,
      [TABLES],
    );
    for (const t of trg) out(`${t.tabla} | ${t.trigger_name} | ${t.action_timing} ${t.event_manipulation}`);
    if (trg.length === 0) out('(ninguno)');

    section('funciones relacionadas (solo nombres)');
    const fns = await q(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and (p.proname like '%webhook%' or p.proname like '%agent%' or p.proname like '%menu%' or p.proname = 'set_updated_at')
        order by 1`,
    );
    for (const f of fns) out(`${f.proname}(${f.args})`);
    if (fns.length === 0) out('(ninguna)');

    const hasWebhook = cols.some((c) => c.table_name === 'webhook_events');
    if (hasWebhook) {
      const colNames = new Set(cols.filter((c) => c.table_name === 'webhook_events').map((c) => c.column_name));
      section('webhook_events — agregados por estado (conteos, sin filas)');
      const byStatus = await q('select status, count(*)::int as filas from webhook_events group by 1 order by 1');
      for (const r of byStatus) out(`status=${r.status} filas=${r.filas}`);
      if (byStatus.length === 0) out('(tabla vacía)');

      const has = (c) => colNames.has(c);
      const agg = [];
      agg.push(['total', 'count(*)']);
      if (has('event_id')) agg.push(['event_id_null', 'count(*) filter (where event_id is null)']);
      if (has('event_name')) agg.push(['event_name_null', 'count(*) filter (where event_name is null)']);
      if (has('payload')) agg.push(['payload_null', 'count(*) filter (where payload is null)']);
      if (has('next_attempt_at')) {
        agg.push([
          'processing_con_next_attempt_at',
          "count(*) filter (where status = 'processing' and next_attempt_at is not null)",
        ]);
        agg.push([
          'processing_sin_next_attempt_at',
          "count(*) filter (where status = 'processing' and next_attempt_at is null)",
        ]);
        agg.push([
          'processing_lease_vencido',
          "count(*) filter (where status = 'processing' and next_attempt_at is not null and next_attempt_at <= now())",
        ]);
        agg.push([
          'processing_lease_vigente',
          "count(*) filter (where status = 'processing' and next_attempt_at > now())",
        ]);
        agg.push([
          'terminales_con_next_attempt_at',
          "count(*) filter (where status in ('processed','failed') and next_attempt_at is not null)",
        ]);
        agg.push([
          'received_sin_next_attempt_at',
          "count(*) filter (where status = 'received' and next_attempt_at is null)",
        ]);
      }
      if (has('attempts') && has('max_attempts')) {
        agg.push(['attempts_ge_max', 'count(*) filter (where attempts >= max_attempts)']);
        agg.push([
          'processing_attempts_ge_max',
          "count(*) filter (where status = 'processing' and attempts >= max_attempts)",
        ]);
      }
      if (has('claim_token')) agg.push(['claim_token_no_nulo', 'count(*) filter (where claim_token is not null)']);
      if (has('claimed_until')) agg.push(['claimed_until_no_nulo', 'count(*) filter (where claimed_until is not null)']);
      const [r] = await q(`select ${agg.map(([n, e]) => `${e}::int as ${n}`).join(', ')} from webhook_events`);
      for (const [n] of agg) out(`${n} = ${r[n]}`);
    } else {
      out('\n(webhook_events no existe: sin agregados)');
    }

    section('conteos por tabla y duplicados (solo agregados)');
    for (const t of TABLES) {
      if (!cols.some((c) => c.table_name === t)) continue;
      const [n] = await q(`select count(*)::int as filas from ${t}`);
      out(`${t}: filas=${n.filas}`);
    }
    if (cols.some((c) => c.table_name === 'agent_messages')) {
      const [d] = await q(
        `select count(*)::int as grupos from (
           select 1 from agent_messages where provider_message_id is not null
           group by provider_message_id having count(*) > 1) d`,
      );
      out(`agent_messages: provider_message_id duplicados (grupos) = ${d.grupos}`);
      const [nn] = await q(
        'select count(*)::int as filas from agent_messages where provider_message_id is null',
      );
      out(`agent_messages: provider_message_id nulos = ${nn.filas}`);
    }

    await client.query('ROLLBACK');
    out('\nFIN: solo SELECT ejecutados dentro de una transacción READ ONLY con ROLLBACK.');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // la conexión se cierra igual
    }
    console.error(`Error durante la introspección (código: ${error && error.code ? error.code : 'n/a'}): ${error && error.code ? '' : String(error.message).slice(0, 120)}`);
    process.exitCode = 5;
  } finally {
    await client.end().catch(() => undefined);
    if (outFile) {
      require('node:fs').writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
      process.stdout.write(`Reporte escrito en ${outFile}\n`);
    }
  }
}

main();
