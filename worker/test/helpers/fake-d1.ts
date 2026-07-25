import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite via a runtime require rather than a static `import`: Vite's
// (and so Vitest's) bundler resolves ESM imports ahead of time against its
// own list of known Node built-ins, which doesn't yet include this
// relatively new one — a static `import { DatabaseSync } from 'node:sqlite'`
// fails to resolve under vitest even though Node itself has the module.
// Going through require() at runtime sidesteps that resolution step
// entirely; Node itself has supported `node:sqlite` since well before this
// project's minimum version.
// Renamed on destructure (DatabaseSyncCtor, not DatabaseSync): TS forbids a
// `const` in the same scope sharing a name with a type-only import, even
// though they occupy different namespaces at the value/type level — the
// import binding itself still claims the identifier.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

// import.meta.url, not __dirname: this project runs as ESM ("type": "module"
// in package.json), where __dirname is a CommonJS-only global and would be
// undefined here.
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', '..', 'migrations');

/**
 * A real, in-memory SQLite database (Node's built-in `node:sqlite`) with
 * this project's actual migration files applied, wrapped in just enough of
 * the D1 surface — `prepare().bind().run()/.first()/.all()`, `batch()` — for
 * `src/db.ts` and the route handlers to run against completely unmodified.
 *
 * This is not a mock: the schema, constraints, and transaction behaviour are
 * real SQLite, exercised through the real migration SQL. It exists because
 * `@cloudflare/vitest-pool-workers` (which runs tests inside actual workerd)
 * would be the "more correct" way to get this, but adds meaningful
 * config/workspace complexity for what's needed here — genuine coverage of
 * a handful of src/db.ts functions and how the unsubscribe/preferences
 * routes react to what's actually in the database. See README.md "Testing".
 */
export function createTestDb(): D1Database {
  const sqlite = new DatabaseSyncCtor(':memory:');
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return wrapAsD1(sqlite);
}

interface FakeStatement {
  bind(...args: unknown[]): FakeStatement;
  run(): Promise<{ success: true; meta: { last_row_id: number; changes: number } }>;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[]; success: true }>;
}

function wrapAsD1(sqlite: DatabaseSync): D1Database {
  function prepare(sql: string): FakeStatement {
    const compiled = sqlite.prepare(sql);
    let bound: unknown[] = [];
    const stmt: FakeStatement = {
      bind(...args: unknown[]) {
        bound = args;
        return stmt;
      },
      async run() {
        const info = compiled.run(...bound);
        return { success: true, meta: { last_row_id: Number(info.lastInsertRowid), changes: Number(info.changes) } };
      },
      async first<T>() {
        const row = compiled.get(...bound);
        return (row === undefined ? null : row) as T | null;
      },
      async all<T>() {
        const rows = compiled.all(...bound);
        return { results: rows as T[], success: true };
      },
    };
    return stmt;
  }

  async function batch(statements: FakeStatement[]): Promise<unknown[]> {
    sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const s of statements) results.push(await s.run());
      sqlite.exec('COMMIT');
      return results;
    } catch (err) {
      sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  // Cast: this deliberately implements only the slice of D1Database that
  // src/db.ts and the route handlers actually call, not the full interface
  // (dump(), raw(), withSession(), ...).
  return { prepare, batch } as unknown as D1Database;
}
