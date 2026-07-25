import type { Env } from '../../src/env';

/** A minimal, fully-populated Env for route-handler tests, backed by
 * whichever D1Database (real or fake) the caller passes in. */
export function testEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    API_URL: 'http://api.test',
    SITE_URL: 'http://site.test',
    ALLOWED_ORIGIN: 'http://site.test',
    EMAIL_PROVIDER: 'console',
    EMAIL_FROM: 'digest@test.example',
    EMAIL_FROM_NAME: 'Evidence Digest Test',
    EMAIL_REPLY_TO: 'digest@test.example',
    BATCH_SIZE: '15',
    MAX_TOPICS: '40',
    MAX_TOPIC_FILES_PER_TICK: '10',
    ...overrides,
  };
}
