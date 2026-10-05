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

  describe('aiTestPhones', () => {
    const originalAiTestPhones = process.env.AI_TEST_PHONES;

    beforeEach(() => {
      process.env.DATABASE_URL = 'postgresql://configured-for-test';
      process.env.JWT_SECRET = 'configured-for-test';
    });

    afterEach(() => restoreEnv('AI_TEST_PHONES', originalAiTestPhones));

    it('is empty by default (unset in Railway = no behavior change)', () => {
      delete process.env.AI_TEST_PHONES;
      expect(configuration().aiTestPhones).toEqual([]);
    });

    it('parses and normalizes a comma-separated list', () => {
      // normalizePhone con assumeInternational solo agrega el '+' — no inventa
      // código de país — así que los 3 formatos de entrada deben traerlo ya.
      process.env.AI_TEST_PHONES = ' +591 700-00001 , 59170000002, +59170000003 ';
      expect(configuration().aiTestPhones).toEqual(['+59170000001', '+59170000002', '+59170000003']);
    });
  });
});

function restoreEnv(name: 'DATABASE_URL' | 'JWT_SECRET' | 'AI_TEST_PHONES', value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
