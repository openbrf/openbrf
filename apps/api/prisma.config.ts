import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig, env } from "prisma/config";

// Prisma 7 does not load .env on its own. The API reads DATABASE_URL from the
// environment in production; for local CLI use we load the repo-root .env if
// it exists so `prisma migrate dev` works without exporting variables.
const rootEnvFile = resolve(import.meta.dirname, "../../.env");
if (existsSync(rootEnvFile)) {
  process.loadEnvFile(rootEnvFile);
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
