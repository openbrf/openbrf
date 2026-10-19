import { randomUUID } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  addLocalDays,
  formatDateColumn,
  formatLocalDay,
  localDayOf,
  parseLocalDay,
} from "@openbrf/shared";
import { z } from "zod";

import { AuditLogService } from "../audit/audit-log.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma, RegisterReportKind } from "../generated/prisma/client";
import { DomainError } from "../http/domain-error";
import {
  type RegisterReport,
  type ReportProblem,
  type ReportSource,
  type ReportSourcePerson,
  renderRegisterReport,
  transferCase,
} from "./register-report-content";
import { readReportedDays } from "./register-report.service";
import {
  REGISTER_TRANSMISSION,
  type RegisterTransmission,
} from "./register-transmission";

/**
 * Sends one report to the cooperative housing register through the port, and
 * records what came of it. ADR 0029.
 *
 * ## The order things happen in, and why
 *
 *   1. Refused outright where nothing is bound on the other side of the port,
 *      before a row is read or a number decrypted.
 *   2. A claim on the duty (`register_transmission_claim`), taken with a try,
 *      so a second board member pressing send while the first waits for
 *      Lantmäteriet is refused rather than queued behind them. A queued second
 *      send would go out the moment the first came back received.
 *   3. The duty, the register rows it points at and the one personal identity
 *      number are read, and the report is rendered and checked against
 *      `registerReportSchema` - or refused, with nothing recorded and nothing
 *      sent, where it could not be complete.
 *   4. The disclosure is recorded and committed: REGISTER_REPORT_TRANSMITTED and
 *      PROTECTED_DATA_REVEALED, naming every person whose number the report
 *      carries. Before the hand-over, so a crash or a lost connection after the
 *      bytes leave cannot leave a disclosure unrecorded. An attempt that never
 *      reached anybody is the price, and the safe side to err on.
 *   5. The report is handed to the port, under a deadline of the service's own
 *      that ends well before the claim expires, so a slow interface ends as an
 *      unknown outcome, with the adapter told to stop, while the claim still
 *      holds. Steps 2 to 4 count against the same deadline, and where they use
 *      it up nothing is handed over.
 *   6. The answer is recorded. Received writes REGISTER_REPORT_MADE, the entry
 *      the queue already reads a discharge from, with Lantmäteriet's day and
 *      reference. Rejected writes REGISTER_REPORT_REJECTED and the duty stays
 *      owed. A throw, an answer that does not parse, or a receipt on a day the
 *      report cannot have come in on writes nothing more and is answered as an
 *      unknown outcome. Then the claim is let go.
 *
 * ## No connection is held across the hand-over
 *
 * Every step is a statement of its own on the pooled client, and none waits for
 * another while holding a connection. That is the reason the claim is a row and
 * not a transaction-scoped advisory lock: a lock lives on the connection whose
 * transaction took it, so it would hold a pool slot for as long as Lantmäteriet
 * took to answer, and the entries step 4 commits on their own would wait for a
 * second slot meanwhile - with a pool of one (OPENBRF_DATABASE_POOL_SIZE=1),
 * for ever, and with any pool, once as many sends as it has slots each held
 * one. Nor can the entries join the lock's transaction instead: a rollback of
 * it would take a disclosure that had happened with it.
 *
 * ## No log line carries the report
 *
 * A thrown error is logged by its class name and the obligation id, never its
 * message: an adapter's error may quote the request it failed on, and the
 * request carries a personal identity number. The convention the mail notice
 * follows for an address quoted back in a refusal, applied to a number.
 */

export type RegisterTransmissionErrorReason =
  | "transmission-not-available"
  | "transmission-in-progress"
  | "transmission-outcome-unknown"
  | "obligation-not-found"
  | "report-already-recorded"
  | ReportProblem;

/**
 * Which reasons are a conflict, which an absence and which a failure upstream.
 *
 * Every refusal of a report that could not be complete is a conflict: nothing
 * about the request is wrong, the register is not in a state a complete report
 * can be rendered from, which is the reading the initial supply takes of the
 * same absences.
 */
const ERROR_STATUS = {
  "transmission-not-available": 409,
  "transmission-in-progress": 409,
  "transmission-outcome-unknown": 502,
  "obligation-not-found": 404,
  "report-already-recorded": 409,
  "association-not-set-up": 409,
  "association-name-missing": 409,
  "association-organization-number-missing": 409,
  "tenant-owner-identity-number-missing": 409,
  "tenant-owner-identity-number-invalid": 409,
  "transfer-case-not-stated": 409,
  "report-incomplete": 409,
} as const satisfies Record<RegisterTransmissionErrorReason, number>;

export class RegisterTransmissionError extends DomainError {
  override readonly status: number;
  override readonly reason: RegisterTransmissionErrorReason;

  constructor(message: string, reason: RegisterTransmissionErrorReason) {
    super(message);
    this.reason = reason;
    this.status = ERROR_STATUS[reason];
  }
}

const PROBLEM_MESSAGE = {
  "association-not-set-up": "The association has not been set up yet.",
  "association-name-missing": "The association has no name recorded.",
  "association-organization-number-missing":
    "The association has no organisation number recorded.",
  "tenant-owner-identity-number-missing":
    "The person this report names has no personal identity number recorded.",
  "tenant-owner-identity-number-invalid":
    "The personal identity number recorded for the person this report names cannot be read.",
  "transfer-case-not-stated":
    "The transfer does not state which case of 3 kap. 3 § it falls in.",
  "report-incomplete":
    "The register lacks something the report has to state, so it would not be complete.",
} as const satisfies Record<ReportProblem, string>;

/** What came of one send. */
export type RegisterTransmissionResult =
  | {
      obligationId: string;
      outcome: "received";
      /** Lantmäteriet's day, which is now the duty's reported day. */
      reportedOn: string;
      reference: string;
    }
  | {
      obligationId: string;
      outcome: "rejected";
      reasons: string[];
    };

/**
 * An answer from the port, checked rather than trusted.
 *
 * The adapter is the one piece of this written against somebody else's
 * interface, and the received day becomes a statutory date on an append-only
 * log. A malformed one is an unknown outcome, never a discharge.
 *
 * The reference and the reason codes are logged and kept on an entry, which
 * records facts rather than whatever an interface chose to say. So each must be
 * a code - no spaces, so no sentence - and nothing in it may be shaped like a
 * personal identity number, so an adapter that passed on a refusal quoting the
 * one in the report cannot put it on the log either.
 */
const IDENTITY_NUMBER_SHAPE = /(?:\d{2})?\d{6}[-+]?\d{4}/;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,99}$/;
const REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function code(pattern: RegExp) {
  return z
    .string()
    .regex(pattern)
    .refine((text) => !IDENTITY_NUMBER_SHAPE.test(text));
}

const outcomeSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("received"),
    receivedOn: z.string().refine((text) => parseLocalDay(text) !== null),
    reference: code(REFERENCE_PATTERN),
  }),
  z.object({
    outcome: z.literal("rejected"),
    reasons: z.array(code(REASON_PATTERN)).max(50),
  }),
]);

/**
 * How long a send is given to hand the report over and hear back, counted from
 * before the claim is taken, so the steps before the hand-over spend it too.
 */
export const SUBMIT_DEADLINE_MS = 60_000;

/**
 * How long a claim holds, counted on the database's clock from when it was
 * taken, which is after the deadline started running.
 *
 * A minute past the deadline, so a claim never expires under a send whose
 * adapter might still be putting a report on the wire, and the answer has the
 * minute to be recorded in. A send ends by letting its claim go; this is only
 * how long a claim left by a process that died stops the duty being sent again.
 */
export const CLAIM_TTL_MS = SUBMIT_DEADLINE_MS + 60_000;

class SubmitDeadlinePassed extends Error {
  constructor() {
    super("The transmission did not answer in time.");
    this.name = "SubmitDeadlinePassed";
  }
}

const PERSON_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  postalStreet: true,
  postalCode: true,
  postalCity: true,
  protectedPersonalData: true,
  personalIdentityNumberCipher: true,
} as const satisfies Prisma.PersonSelect;

@Injectable()
export class RegisterTransmissionService {
  private readonly logger = new Logger(RegisterTransmissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
    @Inject(REGISTER_TRANSMISSION)
    private readonly transmission: RegisterTransmission,
  ) {}

  async transmit(input: {
    actorPersonId: string;
    obligationId: string;
    now?: Date;
  }): Promise<RegisterTransmissionResult> {
    if (!this.transmission.available) {
      throw new RegisterTransmissionError(
        "Reports cannot be sent to the cooperative housing register from this instance yet. Record a report made by hand instead.",
        "transmission-not-available",
      );
    }
    const now = input.now ?? new Date();
    const deadline = Date.now() + SUBMIT_DEADLINE_MS;
    const claim: Claim = {
      obligationId: input.obligationId,
      token: randomUUID(),
      held: false,
    };

    const preparing = this.prepare(input, now, claim, deadline);
    let prepared: Prepared;
    try {
      prepared = await preparing.done;
    } catch (error) {
      if (preparing.cutShort.aborted) {
        // The steps still running stop at their next one, and the claim goes
        // once they have rather than waiting out its expiry.
        void preparing.settled.then(() => this.release(claim));
      } else {
        await this.release(claim);
      }
      throw error;
    }

    try {
      return await this.handOver(input.actorPersonId, prepared, deadline);
    } finally {
      await this.release(claim);
    }
  }

  /**
   * Steps 2 to 4: the claim, the report, and the disclosure entries.
   *
   * Bounded by the deadline. Each step waits for a connection the pool may not
   * have free, and a send that has not reached the hand-over by the deadline
   * hands nothing over: `done` rejects at the deadline as an unknown outcome,
   * and the steps still running check `cutShort` before each write and stop.
   * `settled` resolves once they have, whichever way.
   */
  private prepare(
    input: { actorPersonId: string; obligationId: string },
    now: Date,
    claim: Claim,
    deadline: number,
  ): {
    done: Promise<Prepared>;
    settled: Promise<void>;
    cutShort: AbortSignal;
  } {
    const passed = new AbortController();
    const steps = (async (): Promise<Prepared> => {
      // A claim names a duty by foreign key, so an unknown one is answered as
      // absent before one is taken. A duty is never deleted.
      const exists = await this.prisma.registerReportObligation.findUnique({
        where: { id: input.obligationId },
        select: { id: true },
      });
      if (exists === null) {
        throw new RegisterTransmissionError(
          "No such reporting obligation.",
          "obligation-not-found",
        );
      }

      passed.signal.throwIfAborted();
      await this.take(claim);

      passed.signal.throwIfAborted();
      if (
        (await readReportedDays(this.prisma, [input.obligationId])).size > 0
      ) {
        throw new RegisterTransmissionError(
          "That obligation already carries a report date.",
          "report-already-recorded",
        );
      }
      const source = await this.source(input.obligationId);

      const rendered = renderRegisterReport(source.report, now);
      if (!rendered.ok) {
        if (rendered.problem === "report-incomplete") {
          // The paths the schema refused, which are field names and never a
          // value: what an operator needs to find the gap in the register.
          this.logger.warn(
            `Report ${source.obligationId} to the cooperative housing register: not sent, incomplete at ${(rendered.fields ?? []).join(", ")}`,
          );
        }
        throw new RegisterTransmissionError(
          PROBLEM_MESSAGE[rendered.problem],
          rendered.problem,
        );
      }

      const ledger = {
        kind: source.kind,
        apartmentId: source.apartmentId,
        transferId: source.transferId,
        terminationId: source.terminationId,
        reversalId: source.reversalId,
        triggeredOn: source.triggeredOn,
        dueOn: source.dueOn,
      };

      /*
       * Step 4: committed now, each entry on its own, whatever happens next.
       *
       * The person the report names is the entries' target as well as in
       * their context. A report names one person at most, and the target is
       * what puts the disclosure on that person's own access report - which
       * reads entries by the log's two person columns, not by context.
       */
      const namedPersonId = rendered.personIds[0] ?? null;
      passed.signal.throwIfAborted();
      await this.audit.record({
        action: "REGISTER_REPORT_TRANSMITTED",
        channel: "WEB",
        actorPersonId: input.actorPersonId,
        targetPersonId: namedPersonId,
        targetKind: "registerReportObligation",
        targetId: source.obligationId,
        context: {
          ...ledger,
          recipient: "bostadsrattsregistret",
          basis: "SFS 2026:484 3 kap.",
          personIds: rendered.personIds,
          protectedPersonIds: rendered.protectedPersonIds,
        },
      });
      if (rendered.personIds.length > 0) {
        passed.signal.throwIfAborted();
        await this.audit.record({
          action: "PROTECTED_DATA_REVEALED",
          channel: "WEB",
          actorPersonId: input.actorPersonId,
          targetPersonId: namedPersonId,
          targetKind: "registerReportObligation",
          targetId: source.obligationId,
          context: {
            fields: ["personalIdentityNumber"],
            via: "register-transmission",
            personIds: rendered.personIds,
            protectedPersonIds: rendered.protectedPersonIds,
            // Sent under a statutory duty, as the initial supply is, so there
            // is no typed reason for this to be absent from.
            reason: null,
          },
        });
      }
      return {
        obligationId: source.obligationId,
        now,
        triggeredOn: source.triggeredOn,
        ledger,
        report: rendered.report,
      };
    })();

    const timer = setTimeout(
      () => {
        passed.abort(new SubmitDeadlinePassed());
      },
      Math.max(0, deadline - Date.now()),
    );
    const settled = steps.then(
      () => undefined,
      () => undefined,
    );
    void settled.then(() => {
      clearTimeout(timer);
    });

    const done = Promise.race([
      steps,
      new Promise<never>((_, reject) => {
        passed.signal.addEventListener(
          "abort",
          () => {
            reject(passed.signal.reason);
          },
          { once: true },
        );
      }),
    ]).catch((error: unknown) => {
      if (error instanceof SubmitDeadlinePassed) {
        this.logger.warn(
          `Report ${input.obligationId} to the cooperative housing register: not handed over, the deadline passed first`,
        );
        throw unknownOutcome();
      }
      throw error;
    });
    return { done, settled, cutShort: passed.signal };
  }

  /** Steps 5 and 6: the hand-over, and the record of the answer. */
  private async handOver(
    actorPersonId: string,
    prepared: Prepared,
    deadline: number,
  ): Promise<RegisterTransmissionResult> {
    const { obligationId, ledger } = prepared;
    const answer = await this.submit(prepared.report, obligationId, deadline);

    if (answer.outcome === "rejected") {
      await this.audit.record({
        action: "REGISTER_REPORT_REJECTED",
        channel: "WEB",
        actorPersonId,
        targetKind: "registerReportObligation",
        targetId: obligationId,
        context: { ...ledger, reasons: answer.reasons },
      });
      this.logger.log(
        `Report ${obligationId} to the cooperative housing register rejected: ${answer.reasons.join(", ")}`,
      );
      return { obligationId, outcome: "rejected", reasons: answer.reasons };
    }

    /*
     * The day becomes the duty's reported day on an append-only log, where
     * the earliest entry wins and nothing later can correct it. A receipt
     * for a report sent now came in today, or a day either side of it at
     * midnight, and never before the window opened.
     */
    if (
      !plausibleReceiptDay(
        answer.receivedOn,
        prepared.now,
        prepared.triggeredOn,
      )
    ) {
      this.logger.warn(
        `Report ${obligationId} to the cooperative housing register: the receipt's day is not one the report could have come in on`,
      );
      throw unknownOutcome();
    }

    // Logged before the entry is written, with Lantmäteriet's reference, so
    // a receipt is not lost with nothing to show for it if the write fails.
    this.logger.log(
      `Report ${obligationId} to the cooperative housing register received on ${answer.receivedOn} as ${answer.reference}`,
    );
    await this.audit.record({
      action: "REGISTER_REPORT_MADE",
      channel: "WEB",
      actorPersonId,
      targetKind: "registerReportObligation",
      targetId: obligationId,
      context: {
        ...ledger,
        // Lantmäteriet's day, under the key the queue reads a discharge
        // from, so a duty sent through the port and one stated by hand are
        // reported the same way.
        reportedOn: answer.receivedOn,
        via: "transmission",
        reference: answer.reference,
      },
    });
    return {
      obligationId,
      outcome: "received",
      reportedOn: answer.receivedOn,
      reference: answer.reference,
    };
  }

  /**
   * Takes the duty's claim, or refuses because another send holds it.
   *
   * One statement, so two sends racing for it are ordered by the primary key:
   * the second waits for the first's insert and then finds a claim that has
   * not expired. An expired one is taken over, with a token of this send's.
   */
  private async take(claim: Claim): Promise<void> {
    const taken = await this.prisma.$queryRaw<{ token: string }[]>`
      INSERT INTO "register_transmission_claim" ("obligationId", "token", "expiresAt")
      VALUES (
        ${claim.obligationId},
        ${claim.token},
        now() + make_interval(secs => ${CLAIM_TTL_MS / 1000}::double precision)
      )
      ON CONFLICT ("obligationId") DO UPDATE
        SET "token" = EXCLUDED."token", "expiresAt" = EXCLUDED."expiresAt"
        WHERE "register_transmission_claim"."expiresAt" <= now()
      RETURNING "token"`;
    if (taken[0]?.token !== claim.token) {
      throw new RegisterTransmissionError(
        "That report is being sent already.",
        "transmission-in-progress",
      );
    }
    claim.held = true;
  }

  /**
   * Lets the claim go, if this send took it and still holds it.
   *
   * Never throws: the send's own answer is what the board is waiting for, and a
   * claim that could not be deleted expires on its own.
   */
  private async release(claim: Claim): Promise<void> {
    if (!claim.held) {
      return;
    }
    claim.held = false;
    try {
      await this.prisma.$executeRaw`
        DELETE FROM "register_transmission_claim"
        WHERE "obligationId" = ${claim.obligationId} AND "token" = ${claim.token}`;
    } catch (error) {
      const name = error instanceof Error ? error.name : typeof error;
      this.logger.warn(
        `Report ${claim.obligationId} to the cooperative housing register: the claim was not let go (${name}), and expires on its own`,
      );
    }
  }

  /**
   * Hands the report over and reads the answer back, or says nobody knows.
   *
   * Every way of not getting a readable answer ends in the same refusal,
   * because for the board they are the same thing: the report may or may not
   * have arrived, and Lantmäteriet is the one to ask before sending again.
   *
   * At the deadline the adapter's signal is aborted as well as the wait given
   * up, so the report is not still on its way when the claim is let go. Where
   * the steps before the hand-over took the whole budget, nothing is handed
   * over at all: there would be no time left to read an answer back.
   */
  private async submit(
    report: Parameters<RegisterTransmission["submit"]>[0],
    obligationId: string,
    deadline: number,
  ): Promise<z.infer<typeof outcomeSchema>> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      this.logger.warn(
        `Report ${obligationId} to the cooperative housing register: not handed over, the deadline passed first`,
      );
      throw unknownOutcome();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new SubmitDeadlinePassed());
    }, remaining);
    const passed = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          reject(controller.signal.reason);
        },
        { once: true },
      );
    });
    try {
      const raw = await Promise.race([
        this.transmission.submit(report, { signal: controller.signal }),
        passed,
      ]);
      const parsed = outcomeSchema.safeParse(raw);
      if (!parsed.success) {
        this.logger.warn(
          `Report ${obligationId} to the cooperative housing register: the transmission's answer could not be read`,
        );
        throw unknownOutcome();
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof RegisterTransmissionError) {
        throw error;
      }
      // The class name and nothing the error says: see the note on this service.
      const name = error instanceof Error ? error.name : typeof error;
      this.logger.warn(
        `Report ${obligationId} to the cooperative housing register: outcome unknown (${name})`,
      );
      throw unknownOutcome();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The duty and every row its report is rendered from, with the one number
   * decrypted.
   *
   * Read once the claim is held, so what is rendered is what the duty pointed
   * at when this send took it. The duty and the rows it points at are one
   * statement.
   */
  private async source(obligationId: string): Promise<{
    obligationId: string;
    kind: RegisterReportKind;
    apartmentId: string;
    transferId: string | null;
    terminationId: string | null;
    reversalId: string | null;
    triggeredOn: string | null;
    dueOn: string | null;
    report: ReportSource;
  }> {
    const obligation = await this.prisma.registerReportObligation.findUnique({
      where: { id: obligationId },
      select: {
        id: true,
        kind: true,
        apartmentId: true,
        transferId: true,
        terminationId: true,
        reversalId: true,
        triggeredOn: true,
        dueOn: true,
        apartment: {
          select: {
            number: true,
            address: {
              select: {
                street: true,
                number: true,
                postalCode: true,
                city: true,
              },
            },
          },
        },
        transfer: {
          select: {
            transferredOn: true,
            reportBasis: true,
            membershipDecidedOn: true,
            toPerson: { select: PERSON_SELECT },
          },
        },
        termination: { select: { tookEffectOn: true, kind: true } },
        reversal: {
          select: {
            reversedOn: true,
            kind: true,
            transfer: { select: { transferredOn: true } },
          },
        },
      },
    });
    if (obligation === null) {
      throw new RegisterTransmissionError(
        "No such reporting obligation.",
        "obligation-not-found",
      );
    }

    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { name: true, organizationNumber: true },
    });

    return {
      obligationId: obligation.id,
      kind: obligation.kind,
      apartmentId: obligation.apartmentId,
      transferId: obligation.transferId,
      terminationId: obligation.terminationId,
      reversalId: obligation.reversalId,
      triggeredOn: formatDateColumn(obligation.triggeredOn),
      dueOn: formatDateColumn(obligation.dueOn),
      report: {
        obligationId: obligation.id,
        kind: obligation.kind,
        association,
        apartment: obligation.apartment,
        transfer:
          obligation.transfer === null
            ? null
            : {
                transferredOn: obligation.transfer.transferredOn,
                reportBasis: obligation.transfer.reportBasis,
                membershipDecidedOn: obligation.transfer.membershipDecidedOn,
                toPerson: await this.person(
                  obligation.transfer.toPerson,
                  // Decrypted only where the report will carry it. A transfer
                  // to the association names no person (3 kap. 3 § fjärde
                  // stycket), and one whose case cannot be stated is refused
                  // before it is sent.
                  obligation.kind === "GRANT" ||
                    namesAcquirer(transferCase(obligation.transfer)),
                ),
              },
        termination: obligation.termination,
        reversal:
          obligation.reversal === null
            ? null
            : {
                reversedOn: obligation.reversal.reversedOn,
                kind: obligation.reversal.kind,
                transferredOn: obligation.reversal.transfer.transferredOn,
              },
      },
    };
  }

  /**
   * A person row with its personal identity number decrypted.
   *
   * The plaintext lives in the report and in this local, and nowhere else: not
   * in a log line, not in an entry.
   */
  private async person(
    row: Prisma.PersonGetPayload<{ select: typeof PERSON_SELECT }>,
    named: boolean,
  ): Promise<ReportSourcePerson> {
    return {
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      postalStreet: row.postalStreet,
      postalCode: row.postalCode,
      postalCity: row.postalCity,
      protectedPersonalData: row.protectedPersonalData,
      personalIdentityNumber:
        !named || row.personalIdentityNumberCipher === null
          ? null
          : await this.encryption.decrypt(
              "person.personalIdentityNumber",
              row.personalIdentityNumberCipher,
            ),
    };
  }
}

/** A send's hold on its duty: see {@link RegisterTransmissionService.take}. */
interface Claim {
  obligationId: string;
  token: string;
  held: boolean;
}

/** What the steps before the hand-over leave for it. */
interface Prepared {
  obligationId: string;
  now: Date;
  triggeredOn: string | null;
  ledger: {
    kind: RegisterReportKind;
    apartmentId: string;
    transferId: string | null;
    terminationId: string | null;
    reversalId: string | null;
    triggeredOn: string | null;
    dueOn: string | null;
  };
  report: RegisterReport;
}

/** Whether a transfer's report names its acquirer by number. */
function namesAcquirer(basis: ReturnType<typeof transferCase>): boolean {
  return basis !== null && basis !== "TO_THE_ASSOCIATION";
}

/**
 * Whether a receipt's day is one a report sent at `now` could have come in on:
 * the send day or a day either side of it, and not before the duty's window
 * opened.
 */
function plausibleReceiptDay(
  receivedOn: string,
  now: Date,
  triggeredOn: string | null,
): boolean {
  const sentOn = localDayOf(now);
  const earliest = formatLocalDay(addLocalDays(sentOn, -1));
  const latest = formatLocalDay(addLocalDays(sentOn, 1));
  // "YYYY-MM-DD" sorts as the days it names.
  return (
    receivedOn >= earliest &&
    receivedOn <= latest &&
    receivedOn >= (triggeredOn ?? "")
  );
}

function unknownOutcome(): RegisterTransmissionError {
  return new RegisterTransmissionError(
    "Nobody knows whether the report reached Lantmäteriet. Check with Lantmäteriet before sending it again.",
    "transmission-outcome-unknown",
  );
}
