import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const AGENT_DIR = join(__dirname, '..', '..', 'migrations-agent');
const CENTRAL_DIR = join(__dirname, '..', '..', 'migrations');

const AGENT_TABLES = [
  'webhook_events',
  'agent_conversations',
  'agent_messages',
  'agent_runs',
  'agent_control_events',
  'menu_sessions',
  'menu_send_deliveries',
];

function upOf(file: string, dir = AGENT_DIR): string {
  const text = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
  return text.split('-- Down Migration')[0];
}
function downOf(file: string): string {
  const text = readFileSync(join(AGENT_DIR, file), 'utf8').replace(/\r\n/g, '\n');
  return text.split('-- Down Migration')[1] ?? '';
}
const sqlOnly = (text: string) => text.replace(/--.*$/gm, '');

const FILES = readdirSync(AGENT_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const BASELINE = FILES.filter((f) => /^170000003[123]000_/.test(f));
const DELTA = FILES.find((f) => f.startsWith('1700000036000_')) as string;

describe('migrations-agent (esquema de la DB Agente)', () => {
  it('contiene la base 031-033 y el delta 036', () => {
    expect(BASELINE).toHaveLength(3);
    expect(DELTA).toBeDefined();
  });

  it('crea exactamente las 7 tablas del agente y ninguna de Central', () => {
    const created = FILES.flatMap((f) =>
      [...sqlOnly(upOf(f)).matchAll(/create table (?:if not exists )?(\w+)/g)].map((m) => m[1]),
    );
    expect(created.sort()).toEqual([...AGENT_TABLES].sort());
  });

  it('las carpetas no se pisan: Central no crea tablas del agente', () => {
    for (const f of readdirSync(CENTRAL_DIR).filter((x) => x.endsWith('.sql'))) {
      const up = sqlOnly(upOf(f, CENTRAL_DIR));
      for (const table of AGENT_TABLES) {
        expect(up).not.toMatch(new RegExp(`create table (if not exists )?${table}\b`));
      }
    }
  });

  it('todo CREATE de la base es idempotente (if not exists): adopta una DB existente sin recrear nada', () => {
    for (const f of [...BASELINE, DELTA]) {
      // El único CREATE sin `if not exists` es el UNIQUE de wamids del delta, que
      // vive dentro de un bloque DO guardado por to_regclass(...) is null.
      const up = sqlOnly(upOf(f)).replace(
        /if to_regclass\('uq_agent_messages_provider_message_id'\) is null then[\s\S]*?end \$\$;/,
        '',
      );
      expect(up).not.toMatch(/create (unique )?index (?!if not exists)/);
      expect(up).not.toMatch(/create table (?!if not exists)/);
    }
  });

  it('el Up no borra ni reescribe datos (sin DROP/DELETE/TRUNCATE; el único UPDATE es el respaldo de lease)', () => {
    for (const f of FILES.filter((x) => x.endsWith('.sql'))) {
      const up = sqlOnly(upOf(f));
      expect(up).not.toMatch(/\bdrop\b/i);
      expect(up).not.toMatch(/\bdelete\s+from\b/i);
      expect(up).not.toMatch(/\btruncate\b/i);
    }
    const updates = FILES.flatMap((f) => [...sqlOnly(upOf(f)).matchAll(/^\s*update\s+(\w+)/gim)]);
    expect(updates.map((m) => m[1])).toEqual(['webhook_events']);
  });

  it('los Down no destruyen nada (adoptan tablas con datos)', () => {
    for (const f of FILES) {
      expect(sqlOnly(downOf(f))).not.toMatch(/\bdrop\b|\bdelete\s+from\b|\btruncate\b/i);
    }
  });

  it('no hay claves foráneas hacia orders: el pedido vive en la DB Central', () => {
    for (const f of FILES) {
      expect(sqlOnly(upOf(f))).not.toMatch(/references\s+orders\b/i);
    }
  });

  it('la base 031-033 NO indexa columnas que una webhook_events heredada todavía no tiene', () => {
    // La DB real no tiene claim_token/claimed_until hasta correr el delta 036:
    // un índice sobre ellas en la base haría fallar la cadena entera.
    for (const f of BASELINE) {
      const indexes = [...sqlOnly(upOf(f)).matchAll(/create (?:unique )?index[^;]*;/g)].map(
        (m) => m[0],
      );
      for (const idx of indexes) expect(idx).not.toMatch(/claim_token|claimed_until/);
    }
  });

  it('la base reutiliza los nombres de índice que la DB real ya tiene (no los duplica)', () => {
    const webhook = sqlOnly(upOf(BASELINE[0]));
    expect(webhook).toContain('ix_webhook_events_claimable');
    expect(webhook).toContain('idx_webhook_events_message_id');
    expect(webhook).not.toContain('idx_webhook_events_claimable');
    expect(sqlOnly(upOf(BASELINE[1]))).toContain('idx_agent_conversations_pause_expires_at');
    expect(sqlOnly(upOf(BASELINE[1]))).not.toContain('idx_agent_conversations_pause_expiry');
  });

  describe('delta 036', () => {
    const delta = () => sqlOnly(upOf(DELTA));

    it('agrega claim_token y claimed_until solo si faltan', () => {
      expect(delta()).toMatch(/add column if not exists claim_token uuid/);
      expect(delta()).toMatch(/add column if not exists claimed_until timestamptz/);
    });

    it('respalda el lease heredado (next_attempt_at → claimed_until) solo en filas processing sin lease', () => {
      expect(delta()).toMatch(
        /update webhook_events\s+set claimed_until = next_attempt_at\s+where status = 'processing'\s+and claimed_until is null\s+and next_attempt_at is not null;/,
      );
    });

    it('agrega terminal_not_claimed solo si no existe', () => {
      expect(delta()).toMatch(/not exists[\s\S]*webhook_events_terminal_not_claimed/);
    });

    it('no duplica el índice de filas received (ya existe ix_webhook_events_claimable) y sí crea el de leases vencidos', () => {
      expect(delta()).not.toContain('idx_webhook_events_claimable');
      expect(delta()).toContain('idx_webhook_events_expired_claim');
    });

    it('crea el UNIQUE parcial de wamids solo tras comprobar que no hay duplicados', () => {
      const d = delta();
      const check = d.indexOf('having count(*) > 1');
      const create = d.indexOf('create unique index uq_agent_messages_provider_message_id');
      expect(check).toBeGreaterThan(-1);
      expect(create).toBeGreaterThan(check);
      expect(d).toMatch(/where provider_message_id is not null;/);
    });

    it('agrega los índices que la DB real no tiene y el código usa', () => {
      expect(delta()).toContain('ix_agent_messages_recent');
      expect(delta()).toContain('idx_menu_sessions_customer_phone');
    });
  });
});
