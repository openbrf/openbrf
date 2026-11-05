import type { PoolConfig } from "pg";

/**
 * The session time zone every connection the application opens asks for.
 *
 * The register's timestamp columns are `timestamp(3)`, without a zone, and
 * Prisma reads and writes them as UTC. A statement written as raw SQL that
 * assigns `clock_timestamp()` or `now()` to one stores the session's local
 * wall-clock time instead, so a database whose `TimeZone` is not UTC would
 * shift every expiry such a statement writes, by the zone's offset, relative
 * to the one Prisma compares it with. The PostgreSQL image defaults to UTC; a
 * managed database, or a server installed on a host in another zone, may not.
 *
 * It is a start-up parameter of the connection rather than a setting stored in
 * the database, for three reasons. It needs no privilege and no migration, so
 * it holds for a deployment that manages the database and its roles itself.
 * It is sent on every connection the pool opens, so no later `ALTER ROLE` or
 * `ALTER DATABASE` can move it. And the deploy step that refuses settings
 * stored for the schema owner or the database (docs/deployment.md) keeps
 * finding none.
 */
export const SESSION_TIME_ZONE = "UTC";

const PIN = `-c TimeZone=${SESSION_TIME_ZONE}`;

/**
 * The `options` start-up parameter that pins the session time zone, after any
 * `options` the operator's connection string already carries. PostgreSQL
 * applies the last `-c` for a setting, so the pin wins over one of their own.
 */
function pinnedOptions(existing: string | null): string {
  const kept = existing?.trim() ?? "";
  return kept === "" ? PIN : `${kept} ${PIN}`;
}

/**
 * Connection settings with the session time zone pinned.
 *
 * `pg` lets an `options` parameter in the connection string replace the
 * `options` setting, and a truthy `options` setting replace the `PGOPTIONS`
 * environment variable. The pin is therefore written into the string as well
 * as the settings beside it, after whichever of the two `pg` would have read
 * (the string first, then `PGOPTIONS`): a URL ending
 * `?options=-c TimeZone=Asia/Tokyo` must not unpin the zone, and an operator's
 * `PGOPTIONS=-c statement_timeout=5s` must not be dropped by it.
 */
export function pinnedSessionConfig(
  connectionString: string,
  extra: Omit<PoolConfig, "connectionString" | "options"> = {},
): PoolConfig {
  const fromEnvironment = process.env.PGOPTIONS ?? null;
  let pinned = connectionString;
  try {
    const url = new URL(connectionString);
    const fromUrl = url.searchParams.get("options");
    url.searchParams.set(
      "options",
      pinnedOptions(
        fromUrl !== null && fromUrl.trim() !== "" ? fromUrl : fromEnvironment,
      ),
    );
    pinned = url.toString();
  } catch {
    // Not a URL `pg` could read either; it reports the string itself.
  }
  return {
    ...extra,
    connectionString: pinned,
    options: pinnedOptions(fromEnvironment),
  };
}
