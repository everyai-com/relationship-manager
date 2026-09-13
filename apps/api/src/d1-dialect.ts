import type { CompiledQuery, DatabaseConnection, Dialect, Driver, KyselyConfig, QueryResult } from "kysely";
import { D1Dialect } from "kysely-d1";

/**
 * Kysely over D1, with values D1 will actually accept.
 *
 * D1's `bind()` takes null, number, string and ArrayBuffer — nothing else. The
 * stock dialect hands it whatever the caller passed, so a `Date` (Better Auth
 * writes real Dates for every timestamp) throws
 * `D1_TYPE_ERROR: Type 'object' not supported`. Booleans fail the same way.
 *
 * Dates are stored as epoch milliseconds: that reads correctly whether the
 * caller compares them directly (`expiresAt < new Date()`, where the Date
 * coerces to a number) or wraps them (`new Date(expiresAt)`).
 */

type Bindable = null | number | string | ArrayBuffer;

export function toBindable(value: unknown): Bindable {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string" || value instanceof ArrayBuffer) return value;
  return JSON.stringify(value);
}

class ValueSafeDialect implements Dialect {
  private inner: D1Dialect;

  constructor(database: D1Database) {
    // The package's constructor type is loose; the config shape is `{ database }`.
    this.inner = new D1Dialect({ database } as unknown as ConstructorParameters<typeof D1Dialect>[0]);
  }

  createAdapter() {
    return this.inner.createAdapter();
  }

  createIntrospector(db: Parameters<Dialect["createIntrospector"]>[0]) {
    return this.inner.createIntrospector(db);
  }

  createQueryCompiler(): ReturnType<Dialect["createQueryCompiler"]> {
    return this.inner.createQueryCompiler();
  }

  createDriver(): Driver {
    const driver = this.inner.createDriver();
    return {
      init: () => driver.init(),
      acquireConnection: async (): Promise<DatabaseConnection> => {
        const connection = await driver.acquireConnection();
        return {
          executeQuery: async <R>(compiled: CompiledQuery): Promise<QueryResult<R>> =>
            connection.executeQuery<R>({
              ...compiled,
              parameters: compiled.parameters.map(toBindable),
            }),
          streamQuery: <R>(compiled: CompiledQuery, chunkSize = 100) => connection.streamQuery<R>(compiled, chunkSize),
        };
      },
      beginTransaction: (connection, settings) => driver.beginTransaction(connection, settings),
      commitTransaction: (connection) => driver.commitTransaction(connection),
      rollbackTransaction: (connection) => driver.rollbackTransaction(connection),
      releaseConnection: (connection) => driver.releaseConnection(connection),
      destroy: () => driver.destroy(),
    };
  }
}

export function d1Dialect(database: D1Database): KyselyConfig["dialect"] {
  return new ValueSafeDialect(database) as unknown as KyselyConfig["dialect"];
}
