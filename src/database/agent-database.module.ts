import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { AgentDatabase } from './agent-types';
import { AppConfig } from '../config/configuration';

/**
 * Conexión a la DB AGENTE (WhatsApp/agente/menú): AGENT_DATABASE_URL. Pool y
 * cadena de conexión propios — nunca se comparte con KYSELY (DATABASE_URL).
 */
export const AGENT_KYSELY = Symbol('AGENT_KYSELY');

export function createAgentKysely(agentDatabaseUrl: string): Kysely<AgentDatabase> {
  if (!agentDatabaseUrl) {
    // Sin URL NO se cae a DATABASE_URL ni a los PG* del entorno (pg conectaría a
    // localhost por defecto): el pool ni se crea, y cualquier consulta falla
    // con un mensaje claro. La app sigue arrancando (agente apagado por defecto).
    return new Kysely<AgentDatabase>({
      dialect: new PostgresDialect({
        pool: async () => {
          throw new Error(
            'AGENT_DATABASE_URL no está configurada: la DB del agente no está disponible.',
          );
        },
      }),
    });
  }
  return new Kysely<AgentDatabase>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: agentDatabaseUrl }) }),
  });
}

@Global()
@Module({
  providers: [
    {
      provide: AGENT_KYSELY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const url = config.get('agentDatabaseUrl', { infer: true });
        if (!url) {
          new Logger('AgentDatabase').warn(
            'AGENT_DATABASE_URL vacía: agente, menú e inbox de webhooks no tendrán base de datos.',
          );
        }
        return createAgentKysely(url);
      },
    },
  ],
  exports: [AGENT_KYSELY],
})
export class AgentDatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(AGENT_KYSELY) private readonly db: Kysely<AgentDatabase>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
