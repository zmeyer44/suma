import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * Driver-agnostic database handle: postgres-js against Neon in production,
 * PGlite in tests — the app factory accepts either.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export function createDb(url: string): PostgresJsDatabase<typeof schema> {
  // Neon's pooled endpoints do not support prepared statements.
  const client = postgres(url, { prepare: false });
  return drizzle(client, { schema });
}

/** Local-dev PGlite data directory, relative to the service's working dir. */
const PGLITE_DEFAULT_DIR = ".pglite";

/**
 * Resolve `DATABASE_URL` to a handle. Anything that looks like a Postgres URL
 * goes to `createDb`; the sentinel `pglite` (optionally `pglite:<dir>`) starts
 * the embedded PGlite the tests already run on, so `pnpm dev` needs no Neon
 * instance.
 *
 * PGlite is a devDependency, so the import is dynamic: a production boot with
 * a real `DATABASE_URL` never touches it, and its absence from a production
 * install cannot break the postgres-js path.
 */
export async function createDbFromUrl(url: string): Promise<Db> {
  if (url !== "pglite" && !url.startsWith("pglite:")) return createDb(url);

  const dir = url === "pglite" ? PGLITE_DEFAULT_DIR : url.slice("pglite:".length);
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  console.warn(
    `DATABASE_URL=${url}: running on embedded PGlite in ${dir}. Local dev only — ` +
      "this database is a directory on this machine, not the control plane's.",
  );
  return drizzlePglite(new PGlite(dir), { schema });
}
