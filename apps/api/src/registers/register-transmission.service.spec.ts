import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RecordingRegisterTransmission } from "../testing/recording-register-transmission";
import {
  RegisterTransmissionService,
  SUBMIT_DEADLINE_MS,
} from "./register-transmission.service";

/**
 * What the service accepts back from the port, and how long it waits for it.
 * ADR 0029.
 *
 * The transaction is a stand-in, so the deadline can be run on a fake clock;
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
    /** How long each entry written before the hand-over takes. */
    recordTakes?: number;
  } = {},
) {
  const tx = {
    $queryRaw: vi.fn(() => Promise.resolve([{ held: true }])),
    registerReportObligation: {
      findUnique: vi.fn(() =>
        Promise.resolve(options.obligation ?? termination),
      ),
    },
    association: {
      findUnique: vi.fn(() =>
        Promise.resolve({
          name: "Brf Talgoxen",
          organizationNumber: "769600-0101",
        }),
      ),
    },
    auditLogEntry: { findMany: vi.fn(() => Promise.resolve([])) },
  };
  const prisma = {
    $transaction: vi.fn(
      (work: (client: typeof tx) => Promise<unknown>, _options: object) =>
        work(tx),
    ),
  };
  const encryption = {
    decrypt: vi.fn(() => Promise.resolve(IDENTITY_NUMBER)),
  };
  const audit = {
    record: vi.fn(
      (_entry: { action: string }) =>
        new Promise<void>((resolve) => {
          if (options.recordTakes === undefined) {
            resolve();
          } else {
            setTimeout(resolve, options.recordTakes);
          }
        }),
    ),
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
  return { prisma, encryption, stub, transmit, recorded };
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

describe("the deadline", () => {
  it("leaves the lock's transaction time to spare after it", async () => {
    const { prisma, stub, transmit } = setUp();
    stub.receiveNext("2026-10-19");

    await transmit();

    const options = prisma.$transaction.mock.calls[0]?.[1] as {
      timeout: number;
    };
    expect(options.timeout - SUBMIT_DEADLINE_MS).toBeGreaterThanOrEqual(30_000);
  });

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

  it("is counted from before the transaction, not from the hand-over", async () => {
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
