/** Minimal ambient typing for the handful of Node built-in modules this
 * test-only harness uses (`node:sqlite`, plus the bits of `node:fs`,
 * `node:path`, `node:url` needed to locate and load the migration files).
 * Deliberately not pulling in the full `@types/node` package for this: its
 * global augmentations (Buffer, process, the NodeJS namespace, and its own
 * DOM-ish lib types) overlap with and can conflict with
 * `@cloudflare/workers-types`' worker-runtime globals across the whole
 * program — this project's tsconfig `types` array is intentionally scoped
 * to just the two packages the actual Worker source needs, and a stray
 * `/// <reference types="node" />` would undo that program-wide. Only
 * `test/helpers/fake-d1.ts` uses these. */
declare module 'node:sqlite' {
  export class DatabaseSync {
    constructor(location: string, options?: Record<string, unknown>);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }

  export class StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
  }
}

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: string): string;
  export function readdirSync(path: string): string[];
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}

declare module 'node:module' {
  export function createRequire(url: string): (id: string) => unknown;
}

// The project's tsconfig `lib` is scoped to ES2022 only (no "DOM"), which is
// where TS otherwise picks up `ImportMeta.url`. fake-d1.ts needs it to find
// migrations/ relative to itself under ESM, where __dirname doesn't exist.
interface ImportMeta {
  readonly url: string;
}
