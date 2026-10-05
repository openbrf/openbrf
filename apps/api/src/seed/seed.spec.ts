import { describe, expect, it, vi } from "vitest";

import type { PrismaClient } from "../generated/prisma/client";
import { DEMO_ASSOCIATION } from "./demo-data";
import { DEMO_SEED_FLAG, demoSeedRefusal } from "./seed";

/**
 * When the demo seed refuses.
 *
 * The seed writes member register entries that can never be deleted, so the
 * question that matters is not whether it runs on a development database but
 * whether anything stops it on a real one. NODE_ENV defaults to development,
 * so a checkout pointed at a real instance's database passes that check; what
 * stops it is the explicit flag and what the database already holds.
 */

interface Holding {
  associationName?: string;
  /** People and member register entries the seed did not write. */
  ownPeople?: number;
  ownEntries?: number;
}

function database({ associationName, ownPeople = 0, ownEntries = 0 }: Holding) {
  return {
    association: {
      findUnique: vi.fn(async () =>
        associationName === undefined ? null : { name: associationName },
      ),
    },
    person: { count: vi.fn(async () => ownPeople) },
    memberRegisterEntry: { count: vi.fn(async () => ownEntries) },
  };
}

const ASKED = { nodeEnv: "development", argv: [DEMO_SEED_FLAG] };

async function refusal(holding: Holding, invocation = ASKED) {
  return demoSeedRefusal(
    database(holding) as unknown as PrismaClient,
    invocation,
  );
}

describe("the demo seed", () => {
  it("runs on an empty database when asked for", async () => {
    await expect(refusal({})).resolves.toBeNull();
  });

  it("runs again over its own demo association", async () => {
    // Idempotent by design, so a second run is the ordinary case.
    await expect(
      refusal({ associationName: DEMO_ASSOCIATION.name }),
    ).resolves.toBeNull();
  });

  it("refuses unless the flag is given", async () => {
    await expect(
      refusal({}, { nodeEnv: "development", argv: [] }),
    ).resolves.toContain(DEMO_SEED_FLAG);
  });

  it("refuses in production", async () => {
    await expect(
      refusal({}, { nodeEnv: "production", argv: [DEMO_SEED_FLAG] }),
    ).resolves.toContain("production");
  });

  it("refuses an association under another name", async () => {
    // The seed would rename it to the demo's.
    await expect(
      refusal({ associationName: "Brf Ekhagen" }),
    ).resolves.not.toBeNull();
  });

  it("refuses a database holding people it did not write", async () => {
    await expect(refusal({ ownPeople: 1 })).resolves.not.toBeNull();
  });

  it("refuses a database holding member register entries it did not write", async () => {
    await expect(refusal({ ownEntries: 1 })).resolves.not.toBeNull();
  });

  it("counts only rows outside the seed's own id prefix", async () => {
    const fake = database({});
    await demoSeedRefusal(fake as unknown as PrismaClient, ASKED);

    expect(fake.person.count).toHaveBeenCalledWith({
      where: { NOT: { id: { startsWith: "seed-person-" } } },
    });
    expect(fake.memberRegisterEntry.count).toHaveBeenCalledWith({
      where: { NOT: { personId: { startsWith: "seed-person-" } } },
    });
  });
});
