import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig } from "prisma/config";

// Prisma 7 does not load .env on its own. The API reads DATABASE_URL from the
// environment in production; for local CLI use we load the repo-root .env if
// it exists so `prisma migrate dev` works without exporting variables.
const rootEnvFile = resolve(import.meta.dirname, "../../.env");
if (existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

// Declared only when present. `prisma generate` produces the client from the
// schema alone and needs no connection, so requiring a URL here would make code
// generation - and therefore typecheck, lint and test, which depend on it - fail
// on any machine or CI job that has no database. Migration commands still get a
// clear error from Prisma when the datasource is absent.
const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  ...(databaseUrl === undefined || databaseUrl === ""
    ? {}
    : { datasource: { url: databaseUrl } }),
});
