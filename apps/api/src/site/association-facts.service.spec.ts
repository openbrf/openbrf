import { describe, expect, it, vi } from "vitest";

import type { PrismaService } from "../database/prisma.service";
import {
  AssociationFactsError,
  type AssociationFactsInput,
  AssociationFactsService,
} from "./association-facts.service";

/**
 * The facts a broker asks for, as rules rather than as an endpoint.
 *
 * Two of them matter more than the rest. Every fact here is board-typed free
 * text that is public the moment it is saved - there is no draft and no
 * separate act of publishing - so the personal identity number rule the page
 * editor applies at publication time applies to every save. And a fact cleared
 * back to nothing has to become nothing: a fee policy the board deletes because
 * it no longer holds must come off the page, not stay on it as an empty row.
 */

const STORED = {
  id: 1,
  propertyDesignation: null,
  buildYear: null,
  siteLeasehold: null,
  siteLeaseholdNote: null,
  feePolicy: null,
  feeIncludes: null,
  transferFeePolicy: null,
  pledgeFeePolicy: null,
  legalPersonOwners: null,
  legalPersonOwnersNote: null,
  parking: null,
  storage: null,
  renovations: null,
  createdAt: new Date("2026-09-01T09:00:00.000Z"),
  updatedAt: new Date("2026-09-01T09:00:00.000Z"),
};

interface Fakes {
  service: AssociationFactsService;
  associationFacts: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
}

function build(row: object | null = null): Fakes {
  const associationFacts = {
    findUnique: vi.fn().mockResolvedValue(row),
    upsert: vi.fn(async (args: { update: object }) => ({
      ...STORED,
      ...args.update,
    })),
  };

  return {
    service: new AssociationFactsService({
      associationFacts,
    } as unknown as PrismaService),
    associationFacts,
  };
}

async function refusalOf(
  run: Promise<unknown>,
): Promise<AssociationFactsError> {
  try {
    await run;
  } catch (cause) {
    if (cause instanceof AssociationFactsError) {
      return cause;
    }
    throw cause;
  }
  throw new Error("The save was accepted, and this test is about a refusal.");
}

describe("reading facts nobody has recorded", () => {
  it("answers with every fact unrecorded rather than with nothing", async () => {
    // An instance whose board has never opened the screen has no row. The
    // public page is served from this answer, and it is what makes the page
    // exist from the moment the feature ships.
    const { service } = build(null);

    const facts = await service.read();

    expect(facts.propertyDesignation).toBeNull();
    expect(facts.siteLeasehold).toBeNull();
    expect(facts.updatedAt).toBeNull();
  });
});

describe("what a save keeps", () => {
  it("stores the text the board typed, trimmed", async () => {
    const { service, associationFacts } = build();

    await service.save({ propertyDesignation: "  Talgoxen 4 \n" });

    expect(associationFacts.upsert.mock.calls[0]?.[0]).toMatchObject({
      update: { propertyDesignation: "Talgoxen 4" },
    });
  });

  it("reads a field cleared back to nothing as unrecorded", async () => {
    // The board deleting a fee policy that no longer holds has to take it off
    // the page. An empty string stored as written would leave a labelled row
    // with nothing under it.
    const { service, associationFacts } = build();

    await service.save({ feePolicy: "   ", feeIncludes: null });

    expect(associationFacts.upsert.mock.calls[0]?.[0]).toMatchObject({
      update: { feePolicy: null, feeIncludes: null },
    });
  });

  it("leaves a field the request did not mention alone", async () => {
    const { service, associationFacts } = build();

    await service.save({ parking: "Ingen parkering." });

    const call = associationFacts.upsert.mock.calls[0]?.[0] as
      { update: AssociationFactsInput } | undefined;
    expect(Object.keys(call?.update ?? {})).toEqual(["parking"]);
  });

  it("keeps a no apart from a not-recorded", async () => {
    // "The association owns the land" and "the board has not said" are
    // different answers to a broker, and false must not collapse into null.
    const { service, associationFacts } = build();

    await service.save({ siteLeasehold: false, legalPersonOwners: null });

    expect(associationFacts.upsert.mock.calls[0]?.[0]).toMatchObject({
      update: { siteLeasehold: false, legalPersonOwners: null },
    });
  });
});

describe("what a save refuses", () => {
  it("refuses a personal identity number in any fact", async () => {
    const { service, associationFacts } = build();

    const refusal = await refusalOf(
      service.save({ renovations: "Stammar 2019, kontakt 19811218-9876." }),
    );

    expect(refusal.reason).toBe("personal-identity-number");
    expect(refusal.status).toBe(422);
    // Nothing was written: the refusal happens before the row is touched.
    expect(associationFacts.upsert).not.toHaveBeenCalled();
  });

  it("says which fact carries it, and where, and never what it is", async () => {
    const { service } = build();

    const refusal = await refusalOf(
      service.save({ feePolicy: "Fråga 19811218-9876 om avgiften." }),
    );

    expect(refusal.details()).toEqual({
      locations: [{ field: "feePolicy", offset: 6 }],
    });
    // The value is the thing that must not travel back: not in the body, not
    // in a log, not onto the screen of whoever pasted it.
    expect(JSON.stringify(refusal.details())).not.toContain("9876");
    expect(refusal.message).not.toContain("9876");
  });

  it("does not refuse an organisation number or a date", async () => {
    // The scanner runs the anchored validator over unanchored candidates, so a
    // housing cooperative writing its own organisation number into a fact - the
    // most ordinary thing on this page - is not stopped.
    const { service, associationFacts } = build();

    await service.save({
      feeIncludes: "Föreningen 769600-0000 höjde avgiften 2024-01-01.",
    });

    expect(associationFacts.upsert).toHaveBeenCalled();
  });
});
