import { PrismaPg } from "@prisma/adapter-pg";

import { loadEnv } from "../config/env";
import { loadNearestEnvFile } from "../config/load-env-file";
import { PrismaClient } from "../generated/prisma/client";
import { DEMO_ASSOCIATION } from "./demo-data";
import { demoSeedRefusal, seedDemoData } from "./seed";

/**
 * CLI entry point: pnpm --filter @openbrf/api db:seed --demo-data
 *
 * Refuses unless asked for, outside production, against a database holding
 * nothing but its own demo rows (demoSeedRefusal). The demo data is a design
 * and test fixture, and writing it into a real association's register would
 * create statutory member register entries that cannot be deleted afterwards.
 */
async function main(): Promise<void> {
  loadNearestEnvFile();
  const env = loadEnv();

  // The owner's connection, not the application's: seeding writes rows the
  // application role is deliberately unable to write.
  if (env.DATABASE_URL === undefined) {
    throw new Error(
      "DATABASE_URL is not set. Seeding connects as the schema owner, so a " +
        "runtime connection alone is not enough.",
    );
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: env.DATABASE_URL,
    }),
  });

  try {
    const refusal = await demoSeedRefusal(prisma, {
      nodeEnv: env.NODE_ENV,
      argv: process.argv.slice(2),
    });
    if (refusal !== null) {
      throw new Error(refusal);
    }
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
