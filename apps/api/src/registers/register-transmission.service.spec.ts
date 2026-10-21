import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RecordingRegisterTransmission } from "../testing/recording-register-transmission";
import {
  CLAIM_TTL_MS,
  RegisterTransmissionService,
  SUBMIT_DEADLINE_MS,
} from "./register-transmission.service";

/**
 * What the service accepts back from the port, how long it waits for it, and
 * what it holds while it does. ADR 0029.
 *
 * The database is a stand-in, so the deadline can be run on a fake clock;
 * register-transmission.int-spec.ts holds the same rules against a database.
 */

const NOW = new Date("2026-10-19T10:00:00.000Z");
const IDENTITY_NUMBER = "19811218-9876";

function column(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

const apartment = {
  number: "1101",
  address: {
    street: "Aspgatan",
    number: "7",
    postalCode: "11144",
    city: "Stockholm",
  },
};

const termination = {
  id: "obligation-termination",
  kind: "TERMINATION",
  apartmentId: "apartment-1",
  transferId: null,
  terminationId: "termination-1",
  reversalId: null,
  triggeredOn: column("2026-10-16"),
  dueOn: column("2026-10-30"),
  apartment,
  transfer: null,
  termination: {
    tookEffectOn: column("2026-10-16"),
    kind: "GENERAL_MEETING_DECISION",
  },
  reversal: null,
};

function transfer(
  reportBasis: string | null,
  membershipDecidedOn: Date | null = null,
) {
  return {
    ...termination,
    id: "obligation-transfer",
    kind: "TRANSFER",
    transferId: "transfer-1",
    terminationId: null,
    termination: null,
    transfer: {
      transferredOn: column("2026-10-16"),
      reportBasis,
      membershipDecidedOn,
      toPerson: {
        id: "person-acquirer",
        firstName: "Mira",
        lastName: "Ek",
        postalStreet: "Aspgatan 7",
        postalCode: "11144",
        postalCity: "Stockholm",
        protectedPersonalData: false,
        personalIdentityNumberCipher: "cipher",
      },
    },
  };
}

function setUp(
  options: {
    obligation?: object;
    associationName?: string;
    /** Whether another send holds the duty's claim. */
    claimed?: boolean;
    /** How long each entry written before the hand-over takes. */
    recordTakes?: number;
    /** Holds every entry until the test lets it go. */
    recordWaits?: Promise<void>;
    /** Holds every delete of a claim until the test lets it go. */
    releaseWaits?: Promise<void>;
  } = {},
) {
  /** The token of the claim held, as the table would have it. */
  let claim: string | null = null;
  const prisma = {
    // Takes the claim whoever holds it, as if theirs had expired.
    $queryRaw: vi.fn((_sql: TemplateStringsArray, ...values: unknown[]) => {
      if (options.claimed === true) {
        return Promise.resolve([]);
      }
      claim = values[1] as string;
      return Promise.resolve([{ token: claim }]);
    }),
    // Matches the token when the delete runs, not when it was asked for.
    $executeRaw: vi.fn(
      async (_sql: TemplateStringsArray, ...values: unknown[]) => {
        await options.releaseWaits;
        if (values[1] === claim) {
          claim = null;
          return 1;
        }
        return 0;
      },
    ),
    registerReportObligation: {
      findUnique: vi.fn(() =>
        Promise.resolve(options.obligation ?? termination),
      ),
    },
    association: {
      findUnique: vi.fn(() =>
        Promise.resolve({
          name: options.associationName ?? "Brf Talgoxen",
          organizationNumber: "769600-0101",
        }),
      ),
    },
    auditLogEntry: { findMany: vi.fn(() => Promise.resolve([])) },
  };
  const encryption = {
    decrypt: vi.fn(() => Promise.resolve(IDENTITY_NUMBER)),
  };
  const audit = {
    record: vi.fn((_entry: { action: string }) => {
      if (options.recordWaits !== undefined) {
        return options.recordWaits;
      }
      return new Promise<void>((resolve) => {
        if (options.recordTakes === undefined) {
          resolve();
        } else {
          setTimeout(resolve, options.recordTakes);
        }
      });
    }),
  };
  const stub = new RecordingRegisterTransmission();
  const service = new RegisterTransmissionService(
    prisma as never,
    encryption as never,
    audit as never,
    stub,
  );
  const transmit = () =>
    service.transmit({
      actorPersonId: "person-chair",
      obligationId: "obligation",
      now: NOW,
    });
  const recorded = () => audit.record.mock.calls.map(([entry]) => entry.action);
  const claimHeld = () => claim !== null;
  const claimHolder = () => claim;
  return {
    prisma,
    encryption,
    stub,
    transmit,
    recorded,
    claimHeld,
    claimHolder,
  };
}

/** Silences the service's log, and reads back every line it wrote. */
function spyOnLogs(): () => string {
  const log = vi
    .spyOn(Logger.prototype, "log")
    .mockImplementation(() => undefined);
  const warn = vi
    .spyOn(Logger.prototype, "warn")
    .mockImplementation(() => undefined);
  return () =>
    [...log.mock.calls, ...warn.mock.calls]
      .map((call) => String(call[0]))
      .join("\n");
}

const UNKNOWN = { reason: "transmission-outcome-unknown" };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("what a rejection may say", () => {
  it("records reason codes", async () => {
    const { stub, transmit, recorded } = setUp();
    stub.rejectNext("ORGNR_OKAND", "lgh.nr:saknas");

    await expect(transmit()).resolves.toMatchObject({
      outcome: "rejected",
      reasons: ["ORGNR_OKAND", "lgh.nr:saknas"],
    });
    expect(recorded()).toContain("REGISTER_REPORT_REJECTED");
  });

  it.each([
    ["a sentence", `Personnummer ${IDENTITY_NUMBER} saknas i folkbokföringen`],
    ["a code carrying a twelve-digit number", "PNR_198112189876"],
    ["a code carrying a ten-digit number", "PNR:811218-9876"],
    ["an empty code", ""],
    ["a code too long to be one", "X".repeat(65)],
  ])(
    "treats %s as an unknown outcome, recording and logging none of it",
    async (_, reason) => {
      const logged = spyOnLogs();
      const { stub, transmit, recorded } = setUp();
      stub.rejectNext(reason);

      await expect(transmit()).rejects.toMatchObject(UNKNOWN);
      expect(recorded()).not.toContain("REGISTER_REPORT_REJECTED");
      expect(logged()).not.toContain("9876");
    },
  );
});

describe("what a receipt may say", () => {
  it("records a reference", async () => {
    const { stub, transmit, recorded } = setUp();
    stub.answerNext(() =>
      Promise.resolve({
        outcome: "received",
        receivedOn: "2026-10-19",
        reference: "LM/2026-000123",
      }),
    );

    await expect(transmit()).resolves.toMatchObject({
      outcome: "received",
      reference: "LM/2026-000123",
    });
    expect(recorded()).toContain("REGISTER_REPORT_MADE");
  });

  it.each([
    ["one carrying a number", `LM-${IDENTITY_NUMBER}`],
    ["one with spaces", "received as LM 1"],
    ["one too long to be one", "L".repeat(101)],
  ])(
    "treats a reference that is %s as an unknown outcome",
    async (_, reference) => {
      const logged = spyOnLogs();
      const { stub, transmit, recorded } = setUp();
      stub.answerNext(() =>
        Promise.resolve({
          outcome: "received",
          receivedOn: "2026-10-19",
          reference,
        }),
      );

      await expect(transmit()).rejects.toMatchObject(UNKNOWN);
      expect(recorded()).not.toContain("REGISTER_REPORT_MADE");
      expect(logged()).not.toContain("9876");
    },
  );

  it.each(["2026-10-18", "2026-10-19", "2026-10-20"])(
    "takes a receipt on %s for a report sent on the 19th",
    async (receivedOn) => {
      const { stub, transmit } = setUp();
      stub.receiveNext(receivedOn);

      await expect(transmit()).resolves.toMatchObject({
        outcome: "received",
        reportedOn: receivedOn,
      });
    },
  );

  it.each([
    ["two days before the send", "2026-10-17"],
    ["two days after the send", "2026-10-21"],
    ["far in the future", "2099-01-01"],
    ["an epoch default", "1970-01-01"],
  ])("treats a receipt day %s as an unknown outcome", async (_, receivedOn) => {
    const logged = spyOnLogs();
    const { stub, transmit, recorded } = setUp();
    stub.receiveNext(receivedOn);

    await expect(transmit()).rejects.toMatchObject(UNKNOWN);
    expect(recorded()).not.toContain("REGISTER_REPORT_MADE");
    expect(logged()).not.toContain(receivedOn);
  });

  it("treats a receipt day before the window opened as an unknown outcome", async () => {
    spyOnLogs();
    const { stub, transmit, recorded } = setUp({
      obligation: {
        ...termination,
        triggeredOn: column("2026-10-19"),
        termination: { ...termination.termination, tookEffectOn: NOW },
      },
    });
    stub.receiveNext("2026-10-18");

    await expect(transmit()).rejects.toMatchObject(UNKNOWN);
    expect(recorded()).not.toContain("REGISTER_REPORT_MADE");
  });
});

describe("the claim on the duty", () => {
  it("is taken for longer than the deadline, with time to spare after it", async () => {
    const { prisma, stub, transmit } = setUp();
    stub.receiveNext("2026-10-19");

    await transmit();

    expect(CLAIM_TTL_MS - SUBMIT_DEADLINE_MS).toBeGreaterThanOrEqual(30_000);
    expect(prisma.$queryRaw.mock.calls[0]).toContain(CLAIM_TTL_MS / 1000);
  });

  it("refuses a send while another holds it, before reading, recording or handing over anything", async () => {
    const { encryption, stub, transmit, recorded } = setUp({
      obligation: transfer("ALREADY_MEMBER"),
      claimed: true,
    });

    await expect(transmit()).rejects.toMatchObject({
      reason: "transmission-in-progress",
    });
    expect(encryption.decrypt).not.toHaveBeenCalled();
    expect(recorded()).toEqual([]);
    expect(stub.submitted).toHaveLength(0);
  });

  it.each([
    [
      "received",
      (stub: RecordingRegisterTransmission) => stub.receiveNext("2026-10-19"),
    ],
    [
      "rejected",
      (stub: RecordingRegisterTransmission) => stub.rejectNext("ORGNR_OKAND"),
    ],
    [
      "unknown",
      (stub: RecordingRegisterTransmission) => stub.failNext(new Error("lost")),
    ],
  ])("is let go once the answer is %s", async (_, answer) => {
    spyOnLogs();
    const { stub, transmit, claimHeld } = setUp();
    answer(stub);

    await transmit().catch(() => undefined);

    expect(claimHeld()).toBe(false);
  });

  it("is let go when the report is refused", async () => {
    const { transmit, claimHeld } = setUp({ associationName: "  " });

    await transmit().catch(() => undefined);

    expect(claimHeld()).toBe(false);
  });

  it("is held while the report waits for an answer, with no transaction open", async () => {
    const { prisma, stub, transmit, claimHeld } = setUp();
    let answer: () => void = () => undefined;
    stub.answerNext(
      () =>
        new Promise((resolve) => {
          answer = () => {
            resolve({
              outcome: "received",
              receivedOn: "2026-10-19",
              reference: "LM-1",
            });
          };
        }),
    );

    const sent = transmit();
    await vi.waitFor(() => {
      expect(stub.submitted).toHaveLength(1);
    });
    expect(claimHeld()).toBe(true);
    expect(prisma).not.toHaveProperty("$transaction");

    answer();
    await sent;
    expect(claimHeld()).toBe(false);
  });
});

describe("a report that would not be complete", () => {
  it("records nothing and hands nothing over where the association's name is only spaces", async () => {
    const { stub, transmit, recorded } = setUp({ associationName: "   " });

    await expect(transmit()).rejects.toMatchObject({
      reason: "association-name-missing",
      status: 409,
    });
    expect(recorded()).toEqual([]);
    expect(stub.submitted).toHaveLength(0);
  });

  it("refuses what the schema refuses, naming the field in the log and nothing the report carried", async () => {
    const logged = spyOnLogs();
    const obligation = transfer("ALREADY_MEMBER");
    const { stub, transmit, recorded } = setUp({
      obligation: {
        ...obligation,
        transfer: {
          ...obligation.transfer,
          toPerson: {
            ...obligation.transfer.toPerson,
            firstName: "",
            lastName: " ",
          },
        },
      },
    });

    const refusal = await transmit().catch((error: unknown) => error);

    expect(refusal).toMatchObject({ reason: "report-incomplete", status: 409 });
    expect(String((refusal as Error).message)).not.toContain("9876");
    expect(recorded()).toEqual([]);
    expect(stub.submitted).toHaveLength(0);
    expect(logged()).toContain("event.acquirer.name");
    expect(logged()).not.toContain("9876");
  });
});

describe("the deadline", () => {
  it("aborts the adapter's signal as well as giving up the wait", async () => {
    vi.useFakeTimers();
    spyOnLogs();
    const { stub, transmit } = setUp();
    stub.answerNext(() => new Promise(() => undefined));

    const outcome = expect(transmit()).rejects.toMatchObject(UNKNOWN);
    await vi.advanceTimersByTimeAsync(SUBMIT_DEADLINE_MS);
    await outcome;

    expect(stub.signals).toHaveLength(1);
    expect(stub.signals[0]?.aborted).toBe(true);
  });

  it("is counted from before the claim, not from the hand-over", async () => {
    vi.useFakeTimers();
    spyOnLogs();
    // A termination names nobody, so one entry before the hand-over.
    const { stub, transmit } = setUp({ recordTakes: 20_000 });
    stub.answerNext(() => new Promise(() => undefined));

    const outcome = expect(transmit()).rejects.toMatchObject(UNKNOWN);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stub.signals).toHaveLength(1);
    expect(stub.signals[0]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(SUBMIT_DEADLINE_MS - 20_000);
    await outcome;
    expect(stub.signals[0]?.aborted).toBe(true);
  });

  it("hands nothing over once the entries before it took the whole budget", async () => {
    vi.useFakeTimers();
    spyOnLogs();
    const { stub, transmit, recorded } = setUp({
      recordTakes: SUBMIT_DEADLINE_MS,
    });

    const outcome = expect(transmit()).rejects.toMatchObject(UNKNOWN);
    await vi.advanceTimersByTimeAsync(SUBMIT_DEADLINE_MS);
    await outcome;

    expect(stub.submitted).toHaveLength(0);
    // The disclosure was recorded before the hand-over, which is the side to
    // err on (ADR 0029).
    expect(recorded()).toContain("REGISTER_REPORT_TRANSMITTED");
  });

  it("bounds an entry before the hand-over that does not finish, and stops after it", async () => {
    vi.useFakeTimers();
    spyOnLogs();
    let finish: () => void = () => undefined;
    const { stub, transmit, recorded, claimHeld } = setUp({
      obligation: transfer("ALREADY_MEMBER"),
      recordWaits: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    });

    const outcome = expect(transmit()).rejects.toMatchObject(UNKNOWN);
    await vi.advanceTimersByTimeAsync(SUBMIT_DEADLINE_MS);
    await outcome;
    expect(stub.submitted).toHaveLength(0);

    // The entry the pool kept waiting comes in after all. Nothing follows it,
    // and the claim goes once it has.
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(recorded()).toEqual(["REGISTER_REPORT_TRANSMITTED"]);
    expect(stub.submitted).toHaveLength(0);
    expect(claimHeld()).toBe(false);
  });

  it("answers at the deadline without waiting for the claim's delete, which cannot later take another send's claim", async () => {
    vi.useFakeTimers();
    spyOnLogs();
    let finishDelete: () => void = () => undefined;
    const { prisma, stub, transmit, claimHolder } = setUp({
      releaseWaits: new Promise<void>((resolve) => {
        finishDelete = resolve;
      }),
    });
    stub.answerNext(() => new Promise(() => undefined));

    let first: unknown;
    void transmit().catch((error: unknown) => {
      first = error;
    });
    await vi.advanceTimersByTimeAsync(SUBMIT_DEADLINE_MS);

    // The delete was asked for and is still waiting; the board has its answer.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject(UNKNOWN);

    // A second send takes the duty over, as it would once the first's claim
    // had expired, and is waiting for its own answer.
    const firstToken = prisma.$queryRaw.mock.calls[0]?.[2];
    let answer: () => void = () => undefined;
    stub.answerNext(
      () =>
        new Promise((resolve) => {
          answer = () => {
            resolve({ outcome: "rejected", reasons: ["ORGNR_OKAND"] });
          };
        }),
    );
    const second = transmit();
    await vi.waitFor(() => {
      expect(stub.submitted).toHaveLength(2);
    });
    const secondToken = prisma.$queryRaw.mock.calls[1]?.[2];
    expect(secondToken).not.toBe(firstToken);
    expect(claimHolder()).toBe(secondToken);

    // The first send's delete comes through at last, and leaves the second
    // send's claim where it is.
    finishDelete();
    await vi.advanceTimersByTimeAsync(0);
    expect(claimHolder()).toBe(secondToken);

    answer();
    await expect(second).resolves.toMatchObject({ outcome: "rejected" });
    expect(claimHolder()).toBeNull();
  });
});

describe("whose number is decrypted", () => {
  it("decrypts an acquirer's number for a transfer that names them", async () => {
    const { encryption, stub, transmit } = setUp({
      obligation: transfer("ALREADY_MEMBER"),
    });
    stub.receiveNext("2026-10-19");

    await transmit();

    expect(encryption.decrypt).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["to the association", transfer("TO_THE_ASSOCIATION")],
    [
      "to a lienholding juridical person",
      transfer("LIENHOLDING_JURIDICAL_PERSON"),
    ],
    ["that states no case", transfer(null)],
  ])("decrypts nothing for a transfer %s", async (_, obligation) => {
    const { encryption, stub, transmit } = setUp({ obligation });
    stub.receiveNext("2026-10-19");

    await transmit().catch(() => undefined);

    expect(encryption.decrypt).not.toHaveBeenCalled();
  });
});
