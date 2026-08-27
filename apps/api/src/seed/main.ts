import { PrismaPg } from "@prisma/adapter-pg";

import { loadEnv } from "../config/env";
import { loadNearestEnvFile } from "../config/load-env-file";
import { PrismaClient } from "../generated/prisma/client";
import { DEMO_ASSOCIATION } from "./demo-data";
import { seedDemoData } from "./seed";

/**
 * CLI entry point: pnpm --filter @openbrf/api db:seed
 *
 * Refuses to run in production. The demo data is a design and test fixture,
 * and writing it into a real association's register would create statutory
 * member register entries that cannot be deleted afterwards.
 */
async function main(): Promise<void> {
  loadNearestEnvFile();
  const env = loadEnv();

  if (env.NODE_ENV === "production") {
    throw new Error(
      "Refusing to seed demo data in production: the member register entries " +
        "it creates are append-only and could not be removed.",
    );
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: env.DATABASE_URL,
    }),
  });

  try {
    const result = await seedDemoData(prisma, env);
    console.log(
      `Seeded ${DEMO_ASSOCIATION.name}: ${String(result.addresses)} addresses, ` +
        `${String(result.apartments)} apartments, ${String(result.persons)} persons, ` +
        `${String(result.memberRegisterEntries)} new member register entries.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
