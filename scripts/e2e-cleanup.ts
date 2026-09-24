/**
 * Cleanup manual del E2E contra las DB reales: usa el manifest local para borrar
 * EXCLUSIVAMENTE lo que creó el E2E (ver test/real-db-e2e/support/cleanup.ts).
 *
 *   PowerShell:
 *     $env:ALLOW_REAL_DB_E2E='true'; npm run e2e:cleanup
 *     $env:ALLOW_REAL_DB_E2E='true'; npm run e2e:cleanup -- --dry-run
 *
 * Variables: DATABASE_URL, AGENT_DATABASE_URL, E2E_MANIFEST_PATH (default e2e-manifest.jsonl).
 * Nunca imprime URLs, hosts ni datos de negocio: solo conteos.
 */
import { cleanupFromManifest } from '../test/real-db-e2e/support/cleanup';
import {
  closeReadOnly,
  openAgent,
  openCentral,
  openReadOnly,
} from '../test/real-db-e2e/support/connections';
import { discoverByIdentity } from '../test/real-db-e2e/support/discover';
import { Manifest } from '../test/real-db-e2e/support/manifest';
import { recheckForeignSessions } from '../test/real-db-e2e/support/preflight';

async function main(): Promise<void> {
  if (process.env.ALLOW_REAL_DB_E2E !== 'true') {
    throw new Error('Falta ALLOW_REAL_DB_E2E=true (consentimiento explícito).');
  }
  const centralUrl = process.env.DATABASE_URL ?? '';
  const agentUrl = process.env.AGENT_DATABASE_URL ?? '';
  if (!centralUrl || !agentUrl || centralUrl === agentUrl) {
    throw new Error('DATABASE_URL y AGENT_DATABASE_URL deben estar definidas y ser distintas.');
  }
  const dryRun = process.argv.includes('--dry-run');
  const manifestPath = process.env.E2E_MANIFEST_PATH ?? 'e2e-manifest.jsonl';
  const ignored = (process.env.E2E_IGNORED_APPLICATION_NAMES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const manifest = Manifest.load(manifestPath);
  if (manifest.data.archived) {
    console.log('Ese manifest ya fue consumido por un cleanup anterior: no hay nada que borrar.');
    return;
  }
  console.log(`Manifest: run ${manifest.data.runId}, ${manifest.total()} ids registrados.`);

  const roC = await openReadOnly(centralUrl, 'e2e-cleanup-check');
  const roA = await openReadOnly(agentUrl, 'e2e-cleanup-check');
  try {
    await recheckForeignSessions(roC, roA, ignored);
  } finally {
    await closeReadOnly(roC);
    await closeReadOnly(roA);
  }

  const central = openCentral(centralUrl, 'e2e-cleanup');
  const agent = openAgent(agentUrl, 'e2e-cleanup');
  try {
    await discoverByIdentity(central, agent, manifest);
    if (dryRun) {
      console.log('DRY RUN — ids que se borrarían (no se borra nada):');
      for (const [table, list] of Object.entries(manifest.data.central))
        if (list.length) console.log(`  central.${table}: ${list.length}`);
      for (const [table, list] of Object.entries(manifest.data.agent))
        if (list.length) console.log(`  agent.${table}: ${list.length}`);
      return;
    }
    const report = await cleanupFromManifest(central, agent, manifest);
    console.log('Filas borradas:', JSON.stringify(report.deleted));
    console.log(`Manifest marcado como consumido: ${manifest.archive()}`);
  } finally {
    await central.destroy();
    await agent.destroy();
  }
}

main().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
