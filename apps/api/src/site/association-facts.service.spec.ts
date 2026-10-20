import { describe, expect, it, vi } from "vite-plus/test";

import type { ActorContext } from "../audit/actor-context";
import type { AuditLogService } from "../audit/audit-log.service";
import type { PrismaService } from "../database/prisma.service";
import {
  AssociationFactsError,
  type AssociationFactsInput,
  AssociationFactsService,
  AssociationFactsUnrecordedError,
  StaleAfterMonthsError,
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
 *
 * Every save records who made it. Until this slice nothing did, and a fact
 * changed by a connected app would have been a change to what the association
 * tells a buyer with nothing anywhere saying who changed it.
 *
 * And every save, like a confirmation that changes nothing, moves the date the
 * broker page gives as the facts' last confirmation - which is the one thing a
 * broker has to judge how current the rest is by. How many months that date
 * keeps the facts current is the board's own setting, and changing it is not a
 * confirmation.
 */

/** Whoever is saving, as the controller and the action registry derive them. */
const BOARD_MEMBER: ActorContext = {
  personId: "person-board",
  channel: "WEB",
  requestId: "request-1",
};

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
  confirmedAt: new Date("2026-09-01T09:00:00.000Z") as Date | null,
  staleAfterMonths: 3,
  createdAt: new Date("2026-09-01T09:00:00.000Z"),
  updatedAt: new Date("2026-09-01T09:00:00.000Z"),
};

/** A row the board has answered something in, which a confirmation needs. */
const RECORDED = { ...STORED, parking: "Tolv platser.", buildYear: 1948 };

interface Fakes {
  service: AssociationFactsService;
  associationFacts: {
    findUnique: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  record: ReturnType<typeof vi.fn>;
  /** The raw statements the writers ran: the facts' lock, and nothing else. */
  executeRaw: ReturnType<typeof vi.fn>;
  tx: unknown;
}

function build(row: object | null = null): Fakes {
  const associationFacts = {
    findUnique: vi.fn().mockResolvedValue(row),
    upsert: vi.fn(async (args: { update: object }) => ({
      ...STORED,
      ...args.update,
    })),
    update: vi.fn(async (args: { data: object }) => ({
      ...STORED,
      ...args.data,
    })),
    // What Prisma fills in on a row created with nothing but the threshold.
    create: vi.fn(async (args: { data: object }) => ({
      ...STORED,
      confirmedAt: null,
      updatedAt: new Date(),
      ...args.data,
    })),
  };
  const record = vi.fn(async () => undefined);
  // The transaction runs its body against the same fakes, so the upsert and the
  // entry are asserted to have happened together rather than only to have
  // happened.
  const executeRaw = vi.fn(async () => 0);
  const tx = { associationFacts, $executeRaw: executeRaw };
  const prisma = {
    associationFacts,
    $transaction: async (
      run: (client: unknown) => Promise<unknown>,
    ): Promise<unknown> => run(tx),
  };

  return {
    service: new AssociationFactsService(
      prisma as unknown as PrismaService,
      { record } as unknown as AuditLogService,
    ),
    associationFacts,
    record,
    executeRaw,
    tx,
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

    await service.save(
      { propertyDesignation: "  Talgoxen 4 \n" },
      BOARD_MEMBER,
    );

    expect(associationFacts.upsert.mock.calls[0]?.[0]).toMatchObject({
      update: { propertyDesignation: "Talgoxen 4" },
    });
  });

  it("reads a field cleared back to nothing as unrecorded", async () => {
    // The board deleting a fee policy that no longer holds has to take it off
    // the page. An empty string stored as written would leave a labelled row
    // with nothing under it.
    const { service, associationFacts } = build();

    await service.save({ feePolicy: "   ", feeIncludes: null }, BOARD_MEMBER);

    expect(associationFacts.upsert.mock.calls[0]?.[0]).toMatchObject({
      update: { feePolicy: null, feeIncludes: null },
    });
  });

  it("leaves a field the request did not mention alone", async () => {
    const { service, associationFacts } = build();

    await service.save({ parking: "Ingen parkering." }, BOARD_MEMBER);

    const call = associationFacts.upsert.mock.calls[0]?.[0] as
      { update: AssociationFactsInput } | undefined;
    // The one fact it named, and the date every save moves.
    expect(Object.keys(call?.update ?? {})).toEqual(["parking", "confirmedAt"]);
  });

  it("keeps a no apart from a not-recorded", async () => {
    // "The association owns the land" and "the board has not said" are
    // different answers to a broker, and false must not collapse into null.
    const { service, associationFacts } = build();

    await service.save(
      { siteLeasehold: false, legalPersonOwners: null },
      BOARD_MEMBER,
    );

    expect(associationFacts.upsert.mock.calls[0]?.[0]).toMatchObject({
      update: { siteLeasehold: false, legalPersonOwners: null },
    });
  });
});

describe("what a save refuses", () => {
  it("refuses a personal identity number in any fact", async () => {
    const { service, associationFacts } = build();

    const refusal = await refusalOf(
      service.save(
        { renovations: "Stammar 2019, kontakt 19811218-9876." },
        BOARD_MEMBER,
      ),
    );

    expect(refusal.reason).toBe("personal-identity-number");
    expect(refusal.status).toBe(422);
    // Nothing was written: the refusal happens before the row is touched.
    expect(associationFacts.upsert).not.toHaveBeenCalled();
  });

  it("says which fact carries it, and where, and never what it is", async () => {
    const { service } = build();

    const refusal = await refusalOf(
      service.save(
        { feePolicy: "Fråga 19811218-9876 om avgiften." },
        BOARD_MEMBER,
      ),
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

    await service.save(
      { feeIncludes: "Föreningen 769600-0000 höjde avgiften 2024-01-01." },
      BOARD_MEMBER,
    );

    expect(associationFacts.upsert).toHaveBeenCalled();
  });
});

describe("what a save records", () => {
  it("writes an entry naming the fields and never their text", async () => {
    const { service, record } = build();

    await service.save(
      { feePolicy: "Avgiften höjdes 2026.", parking: "Tolv platser." },
      BOARD_MEMBER,
    );

    expect(record).toHaveBeenCalledTimes(1);
    const entry = record.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry.action).toBe("ASSOCIATION_FACTS_RECORDED");
    expect(entry.actorPersonId).toBe("person-board");
    expect(entry.channel).toBe("WEB");
    expect(entry.context).toEqual({ fields: ["feePolicy", "parking"] });
    // The facts are published the moment they are saved, and the log is
    // append-only and exempt from every purge: a fee policy copied into it
    // would outlive the one on the page.
    expect(JSON.stringify(entry)).not.toContain("Avgiften");
  });

  it("records the channel the caller arrived on rather than assuming the web", async () => {
    const { service, record } = build();

    await service.save(
      { storage: "Källarförråd till varje lägenhet." },
      {
        personId: "person-board",
        channel: "MCP",
        clientId: "client-1",
        clientHost: "app.example",
      },
    );

    const entry = record.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry.channel).toBe("MCP");
    expect(entry.clientId).toBe("client-1");
  });

  it("records a save that changes nothing anybody can see", async () => {
    // The act is what is recorded, not the difference.
    const { service, record } = build(STORED);

    await service.save({ parking: null }, BOARD_MEMBER);

    expect(record).toHaveBeenCalledTimes(1);
  });
});

describe("when the facts were last confirmed", () => {
  it("answers with no date while nothing is recorded", async () => {
    const { service } = build(null);

    expect((await service.read()).confirmedAt).toBeNull();
  });

  it("moves to now on a save, whatever the save changed", async () => {
    const { service, associationFacts } = build(STORED);
    const before = Date.now();

    const saved = await service.save({ parking: null }, BOARD_MEMBER);

    const call = associationFacts.upsert.mock.calls[0]?.[0] as {
      create: { confirmedAt: Date };
      update: { confirmedAt: Date };
    };
    // The first save creates the row and the next ones update it, and both
    // are the board standing behind the facts.
    expect(call.create.confirmedAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(call.update.confirmedAt).toBe(call.create.confirmedAt);
    expect(saved.confirmedAt).toBe(call.update.confirmedAt.toISOString());
  });

  it("leaves the save's entry naming the fields and not the date", async () => {
    // The entry is the record of the date moving. Listing confirmedAt among the
    // fields would claim the board typed it.
    const { service, record } = build();

    await service.save({ parking: "Tolv platser." }, BOARD_MEMBER);

    const entry = record.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry.context).toEqual({ fields: ["parking"] });
  });
});

describe("a save from outside the board's screen", () => {
  /** A connected app, acting as the board member who connected it. */
  const CONNECTED_APP: ActorContext = {
    personId: "person-board",
    channel: "MCP",
    clientId: "client-1",
    clientHost: "app.example",
  };

  it("confirms nothing when it names no fact", async () => {
    // The call a model makes when a broker's mail asks the board to confirm its
    // facts are current. Confirming them unchanged is the board's attestation
    // on its own screen, so this one writes nothing and moves no date.
    const { service, associationFacts } = build(RECORDED);
    const hook = vi.fn(async () => undefined);
    service.onConfirmed(hook);

    const saved = await service.save({}, CONNECTED_APP);

    expect(associationFacts.upsert).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    expect(saved.confirmedAt).toBe("2026-09-01T09:00:00.000Z");
    expect(saved.parking).toBe("Tolv platser.");
  });

  it("confirms nothing when it sends every fact back as it stands", async () => {
    // The same confirmation, dressed as a save. Compared after the trim, so a
    // trailing space and an emptied field are the values they would be stored
    // as.
    const { service, associationFacts } = build(RECORDED);
    const hook = vi.fn(async () => undefined);
    service.onConfirmed(hook);

    await service.save(
      { parking: "Tolv platser. ", buildYear: 1948, feePolicy: "  " },
      CONNECTED_APP,
    );

    expect(associationFacts.upsert).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });

  it("still records the act, with the fields it named", async () => {
    const { service, record } = build(RECORDED);

    await service.save({ parking: "Tolv platser." }, CONNECTED_APP);

    expect(record).toHaveBeenCalledTimes(1);
    const entry = record.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry.action).toBe("ASSOCIATION_FACTS_RECORDED");
    expect(entry.channel).toBe("MCP");
    expect(entry.context).toEqual({ fields: ["parking"] });
  });

  it("creates no row when there is none and it names no fact", async () => {
    const { service, associationFacts } = build(null);

    const saved = await service.save({ feePolicy: null }, CONNECTED_APP);

    expect(associationFacts.upsert).not.toHaveBeenCalled();
    expect(saved.confirmedAt).toBeNull();
  });

  it("reads the row under the lock it writes under", async () => {
    const { service, associationFacts, executeRaw } = build(RECORDED);

    await service.save({}, CONNECTED_APP);

    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      associationFacts.findUnique.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("confirms the facts when it changes one of them", async () => {
    // Whoever changed a fact stood behind what they left, as a board member
    // saving on the screen does.
    const { service, associationFacts } = build(RECORDED);
    const hook = vi.fn(async () => undefined);
    service.onConfirmed(hook);
    const before = Date.now();

    const saved = await service.save(
      { parking: "Tretton platser." },
      CONNECTED_APP,
    );

    expect(associationFacts.upsert).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(Date.parse(saved.confirmedAt ?? "")).toBeGreaterThanOrEqual(before);
  });

  it("is told apart from the board's screen, where a save always confirms", async () => {
    const { service, associationFacts } = build(RECORDED);
    const hook = vi.fn(async () => undefined);
    service.onConfirmed(hook);

    await service.save({}, BOARD_MEMBER);

    expect(associationFacts.upsert).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

describe("confirming the facts unchanged", () => {
  it("moves the date and writes no fact", async () => {
    const { service, associationFacts } = build(RECORDED);
    const before = Date.now();

    const confirmed = await service.confirm(BOARD_MEMBER);

    const call = associationFacts.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(Object.keys(call.data).sort()).toEqual(["confirmedAt", "updatedAt"]);
    expect((call.data.confirmedAt as Date).getTime()).toBeGreaterThanOrEqual(
      before,
    );
    // Handed back as it was, so Prisma does not move it: no fact was written,
    // and updatedAt is when one last was.
    expect(call.data.updatedAt).toEqual(STORED.updatedAt);
    expect(confirmed.updatedAt).toBe(STORED.updatedAt.toISOString());
    expect(confirmed.confirmedAt).not.toBe(STORED.confirmedAt?.toISOString());
    expect(associationFacts.upsert).not.toHaveBeenCalled();
  });

  it("is recorded, with who confirmed and the date it replaced", async () => {
    const { service, record } = build(RECORDED);

    await service.confirm({
      personId: "person-board",
      channel: "WEB",
      requestId: "request-1",
    });

    expect(record).toHaveBeenCalledTimes(1);
    const entry = record.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry.action).toBe("ASSOCIATION_FACTS_CONFIRMED");
    expect(entry.actorPersonId).toBe("person-board");
    expect(entry.channel).toBe("WEB");
    expect(entry.targetKind).toBe("associationFacts");
    expect(entry).not.toHaveProperty("targetPersonId");
    expect(entry.context).toEqual({
      previousConfirmedAt: "2026-09-01T09:00:00.000Z",
    });
  });

  it("is refused while nothing is recorded, and records nothing", async () => {
    // "Confirmed today" over no facts at all would tell a broker the board had
    // answered questions it has not.
    const { service, associationFacts, record } = build(null);

    const refusal = await service.confirm(BOARD_MEMBER).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(refusal).toBeInstanceOf(AssociationFactsUnrecordedError);
    expect((refusal as AssociationFactsUnrecordedError).reason).toBe(
      "nothing-recorded",
    );
    expect((refusal as AssociationFactsUnrecordedError).status).toBe(409);
    expect(associationFacts.update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("is refused once the board has cleared every fact, though a date stands", async () => {
    // A save that empties the last fact still moves the date, so the row has
    // one. It dates no answer, and confirming it would confirm none.
    const { service, associationFacts, record } = build(STORED);
    const hook = vi.fn(async () => undefined);
    service.onConfirmed(hook);

    const refusal = await service.confirm(BOARD_MEMBER).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(refusal).toBeInstanceOf(AssociationFactsUnrecordedError);
    expect(associationFacts.update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
  });
});

describe("how many months the facts count as current", () => {
  it("is three while the board has set nothing", async () => {
    const { service } = build(null);

    expect((await service.read()).staleAfterMonths).toBe(3);
  });

  it("changes without moving the date the facts were last confirmed", async () => {
    // The threshold is not a fact. A board that shortens it has said nothing
    // about the fee policy, and a page that printed "confirmed today" after it
    // would tell a broker it had.
    const { service, associationFacts } = build(STORED);

    const changed = await service.setStaleAfterMonths(6, BOARD_MEMBER);

    const call = associationFacts.update.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(Object.keys(call.data).sort()).toEqual([
      "staleAfterMonths",
      "updatedAt",
    ]);
    expect(call.data.staleAfterMonths).toBe(6);
    expect(call.data.updatedAt).toEqual(STORED.updatedAt);
    expect(changed.staleAfterMonths).toBe(6);
    expect(changed.confirmedAt).toBe("2026-09-01T09:00:00.000Z");
    expect(changed.updatedAt).toBe("2026-09-01T09:00:00.000Z");
    expect(associationFacts.upsert).not.toHaveBeenCalled();
  });

  it("is recorded, with who changed it and the old and the new number", async () => {
    const { service, record } = build({ ...STORED, staleAfterMonths: 3 });

    await service.setStaleAfterMonths(12, BOARD_MEMBER);

    expect(record).toHaveBeenCalledTimes(1);
    const entry = record.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry.action).toBe("ASSOCIATION_FACTS_STALE_AFTER_CHANGED");
    expect(entry.actorPersonId).toBe("person-board");
    expect(entry.targetKind).toBe("associationFacts");
    expect(entry).not.toHaveProperty("targetPersonId");
    expect(entry.context).toEqual({ from: 3, to: 12 });
  });

  it.each([1, 12])("accepts %i, at the edge of the range", async (months) => {
    const { service } = build(STORED);

    expect(
      (await service.setStaleAfterMonths(months, BOARD_MEMBER))
        .staleAfterMonths,
    ).toBe(months);
  });

  it.each([0, 13, 2.5, -1])(
    "refuses %s and records nothing",
    async (months) => {
      const { service, associationFacts, record } = build(STORED);

      const refusal = await service
        .setStaleAfterMonths(months, BOARD_MEMBER)
        .then(
          () => null,
          (cause: unknown) => cause,
        );

      expect(refusal).toBeInstanceOf(StaleAfterMonthsError);
      expect((refusal as StaleAfterMonthsError).status).toBe(422);
      expect(associationFacts.update).not.toHaveBeenCalled();
      expect(associationFacts.create).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    },
  );

  it("can be set before any fact is recorded, and confirms nothing then either", async () => {
    // The row is created to hold the setting and holds no answer, so it has
    // no date for the page to print and no time a fact was written.
    const { service, associationFacts, record } = build(null);

    const changed = await service.setStaleAfterMonths(2, BOARD_MEMBER);

    expect(associationFacts.create).toHaveBeenCalledWith({
      data: { id: 1, staleAfterMonths: 2 },
    });
    expect(changed.staleAfterMonths).toBe(2);
    expect(changed.confirmedAt).toBeNull();
    expect(changed.updatedAt).toBeNull();
    const entry = record.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry.context).toEqual({ from: 3, to: 2 });
  });

  it("leaves a row only the setting created unconfirmable", async () => {
    const { service, record } = build({
      ...STORED,
      confirmedAt: null,
      staleAfterMonths: 2,
    });

    const refusal = await service.confirm(BOARD_MEMBER).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(refusal).toBeInstanceOf(AssociationFactsUnrecordedError);
    expect(record).not.toHaveBeenCalled();
  });
});

describe("the lock every write takes", () => {
  /*
   * A confirmation and a months change read the row and write back the
   * updatedAt they read, so a save landing between the two is undone in part.
   * Whether the lock serialises them is shown against a real database in
   * broker-page.int-spec.ts; here, that each writer takes it before it touches
   * the row, under the one key the others use.
   */
  function lockedFirst(
    executeRaw: ReturnType<typeof vi.fn>,
    touched: ReturnType<typeof vi.fn>,
  ): void {
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const [, key] = executeRaw.mock.calls[0] as [TemplateStringsArray, string];
    expect(key).toBe("association-facts");
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      touched.mock.invocationCallOrder[0] ?? 0,
    );
  }

  it("is taken by a save before it writes", async () => {
    const { service, associationFacts, executeRaw } = build(STORED);

    await service.save({ parking: "Tolv platser." }, BOARD_MEMBER);

    lockedFirst(executeRaw, associationFacts.upsert);
  });

  it("is taken by a confirmation before it reads", async () => {
    const { service, associationFacts, executeRaw } = build(RECORDED);

    await service.confirm(BOARD_MEMBER);

    lockedFirst(executeRaw, associationFacts.findUnique);
  });

  it("is taken by a months change before it reads", async () => {
    const { service, associationFacts, executeRaw } = build(STORED);

    await service.setStaleAfterMonths(6, BOARD_MEMBER);

    lockedFirst(executeRaw, associationFacts.findUnique);
  });
});

describe("what runs when the facts are confirmed", () => {
  it("runs inside a save's transaction, with the new date and the actor", async () => {
    const { service, tx } = build(STORED);
    const hook = vi.fn(async () => undefined);
    service.onConfirmed(hook);

    const saved = await service.save(
      { parking: "Tolv platser." },
      BOARD_MEMBER,
    );

    expect(hook).toHaveBeenCalledTimes(1);
    const [client, event] = hook.mock.calls[0] as unknown as [
      unknown,
      { confirmedAt: Date; actor: ActorContext },
    ];
    expect(client).toBe(tx);
    expect(event.actor).toBe(BOARD_MEMBER);
    expect(event.confirmedAt.toISOString()).toBe(saved.confirmedAt);
  });

  it("runs inside a confirmation's transaction", async () => {
    const { service, tx } = build(RECORDED);
    const hook = vi.fn(async () => undefined);
    service.onConfirmed(hook);

    const confirmed = await service.confirm(BOARD_MEMBER);

    const [client, event] = hook.mock.calls[0] as unknown as [
      unknown,
      { confirmedAt: Date },
    ];
    expect(client).toBe(tx);
    expect(event.confirmedAt.toISOString()).toBe(confirmed.confirmedAt);
  });

  it("does not run when only the threshold changes", async () => {
    const { service } = build(STORED);
    const hook = vi.fn(async () => undefined);
    service.onConfirmed(hook);

    await service.setStaleAfterMonths(6, BOARD_MEMBER);

    expect(hook).not.toHaveBeenCalled();
  });

  it("fails the confirmation when it fails", async () => {
    // Inside the transaction, so a hook that throws takes the confirmation
    // down with it rather than leaving two records disagreeing about one act.
    const { service } = build(RECORDED);
    service.onConfirmed(async () => {
      throw new Error("the request queue is unavailable");
    });

    await expect(service.confirm(BOARD_MEMBER)).rejects.toThrow(
      "the request queue is unavailable",
    );
  });

  it("does not run for a confirmation that is refused", async () => {
    const { service } = build(null);
    const hook = vi.fn(async () => undefined);
    service.onConfirmed(hook);

    await service.confirm(BOARD_MEMBER).catch(() => undefined);

    expect(hook).not.toHaveBeenCalled();
  });
});
