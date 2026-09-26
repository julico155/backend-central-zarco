import configuration from './configuration';

describe('configuration', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalJwtSecret = process.env.JWT_SECRET;

  afterEach(() => {
    restoreEnv('DATABASE_URL', originalDatabaseUrl);
    restoreEnv('JWT_SECRET', originalJwtSecret);
  });

  it('accepts non-blank required configuration without exposing it', () => {
    process.env.DATABASE_URL = 'postgresql://configured-for-test';
    process.env.JWT_SECRET = 'configured-for-test';

    expect(configuration()).toMatchObject({
      databaseUrl: 'postgresql://configured-for-test',
      jwt: { secret: 'configured-for-test' },
    });
  });

  for (const name of ['DATABASE_URL', 'JWT_SECRET'] as const) {
    it(`rejects a missing or blank ${name}`, () => {
      process.env.DATABASE_URL = 'postgresql://configured-for-test';
      process.env.JWT_SECRET = 'configured-for-test';

      delete process.env[name];
      expect(() => configuration()).toThrow(`Missing required environment variable: ${name}`);

      process.env[name] = '   ';
      expect(() => configuration()).toThrow(`Missing required environment variable: ${name}`);
    });
  }
});

function restoreEnv(name: 'DATABASE_URL' | 'JWT_SECRET', value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
