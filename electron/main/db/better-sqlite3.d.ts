// Minimal hand-written typings for the subset of the better-sqlite3 API the
// catalog uses. Kept local (rather than adding @types/better-sqlite3) so the
// dependency surface stays exactly the two packages F3 introduces. Extend this
// declaration as the catalog grows to need more of the library's API.
declare module 'better-sqlite3' {
  export type SqlScalar = string | number | bigint | Buffer | null;

  export interface RunResult {
    readonly changes: number;
    readonly lastInsertRowid: number | bigint;
  }

  export interface Statement {
    run(...params: readonly unknown[]): RunResult;
    get<TRow = unknown>(...params: readonly unknown[]): TRow | undefined;
    all<TRow = unknown>(...params: readonly unknown[]): TRow[];
    iterate<TRow = unknown>(...params: readonly unknown[]): IterableIterator<TRow>;
    pluck(toggle?: boolean): this;
  }

  export interface RegisterFunctionOptions {
    readonly deterministic?: boolean;
    readonly varargs?: boolean;
  }

  export interface Database {
    readonly open: boolean;
    readonly name: string;
    prepare(sql: string): Statement;
    exec(sql: string): this;
    pragma(source: string, options?: { readonly simple?: boolean }): unknown;
    function(name: string, fn: (...args: SqlScalar[]) => SqlScalar): this;
    function(
      name: string,
      options: RegisterFunctionOptions,
      fn: (...args: SqlScalar[]) => SqlScalar,
    ): this;
    transaction<TArgs extends readonly unknown[], TResult>(
      fn: (...args: TArgs) => TResult,
    ): (...args: TArgs) => TResult;
    close(): this;
  }

  export interface DatabaseOptions {
    readonly readonly?: boolean;
    readonly fileMustExist?: boolean;
    readonly timeout?: number;
  }

  export interface DatabaseConstructor {
    new (filename: string, options?: DatabaseOptions): Database;
    (filename: string, options?: DatabaseOptions): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}

// Build-time string import of SQL migration files (Vite `?raw`), so the DDL
// lives in real, auditable .sql files yet ships inlined — no runtime fs read.
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
