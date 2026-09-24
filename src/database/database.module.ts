import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { Database } from './types';
import { AppConfig } from '../config/configuration';

/** Conexión a la DB CENTRAL (negocio): DATABASE_URL. La del agente es AGENT_KYSELY. */
export const KYSELY = Symbol('KYSELY');

@Global()
@Module({
  providers: [
    {
      provide: KYSELY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const pool = new Pool({
          connectionString: config.get('databaseUrl', { infer: true }),
        });
        return new Kysely<Database>({
          dialect: new PostgresDialect({ pool }),
        });
      },
    },
  ],
  exports: [KYSELY],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}
