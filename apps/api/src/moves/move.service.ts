import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type { ResidencyRole } from "../generated/prisma/enums";
import { DomainError } from "../http/domain-error";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { MailService } from "../mail/mail.service";
import {
  boardMoveOutReminderMail,
  moveInMail,
  moveOutMail,
} from "../mail/templates";
import { computePurgeDate } from "../retention/purge-date";
import { retentionDaysAfterMoveOut } from "../retention/retention-policy";

/**
 * Moving someone in and moving someone out.
 *
 * These two flows are where the operational register and the statutory one are
 * kept in step, and that is the whole reason they exist as a service rather
 * than as two writes on a residency row:
 *
 *   Moving in creates the residency, and - when the person takes over a
 *   tenant-ownership and was not already a member - writes the ENTRY row in the
 *   member register (EFL 5 kap.). A transfer may be recorded at the same time.
 *
 *   Moving out sets the move-out date, and writes the EXIT row when the
 *   person's LAST tenant-ownership ends. Membership is derived from holding at
 *   least one, so someone who sells one of two apartments is still a member and
 *   must not be recorded as having left.
 *
 * The member register cannot be updated or deleted - the database refuses both
 * - so a write here that turns out wrong stays wrong until a correction row is
 * added. That is why the register write and the residency write share one
 * transaction: half of this pair committing is the one failure mode that cannot
 * be cleaned up afterwards.
 *
 * One transaction is not enough on its own, because both flows read the
 * person's other residencies to decide what the register write should be. Two
 * transitions for the same person running at once would each read a state the
 * other is about to invalidate, so each transaction takes the person's
 * transition lock before it reads anything (see lockResidencyTransitions), and
 * the move-out closes the residency with a conditional update so a second one
 * is refused rather than writing a second EXIT.
 */

export type MoveErrorReason =
  | "person-not-found"
  | "apartment-not-found"
  | "residency-not-found"
  | "already-resident"
  | "already-moved-out"
  | "moved-out-before-moved-in"
  | "transfer-person-not-found"
  | "transfer-reference-required";

/**
 * The status each refusal answers with.
 *
 * A map rather than a chain of comparisons, so a reason added to the union and
 * not given a status fails the build instead of defaulting to a conflict.
 */
const MOVE_ERROR_STATUS: Record<MoveErrorReason, number> = {
  "person-not-found": 404,
  "apartment-not-found": 404,
  "residency-not-found": 404,
  "transfer-person-not-found": 404,
  "already-resident": 409,
  "already-moved-out": 409,
  "moved-out-before-moved-in": 409,
  "transfer-reference-required": 400,
};

export class MoveError extends DomainError {
  override readonly status: number;
  override readonly reason: MoveErrorReason;

  constructor(message: string, reason: MoveErrorReason) {
    super(message);
    this.reason = reason;
    this.status = MOVE_ERROR_STATUS[reason];
  }
}

/** A transfer of the tenant-ownership recorded alongside a move. */
export interface TransferInput {
  /** ISO calendar date. */
  transferredOn: string;
  /** Decimal string, when the price is recorded. */
  price?: string | null;
  /**
   * The board's reference to the agreement: a case number, or where the paper
   * copy is filed. Required. The apartment register extract states a reference
   * for every transfer it lists (BRL 9 kap.), and a transfer row cannot be
   * deleted once written, so a transfer with nothing to point at is refused
   * rather than recorded.
   */
  agreementReference?: string | null;
}

export interface MoveInInput {
  personId: string;
  apartmentId: string;
  role: ResidencyRole;
  /** ISO calendar date. */
  movedInOn: string;
  /**
   * Records the transfer this move-in is the result of. The person moving in is
   * the acquirer; `fromPersonId` names the seller, or is omitted for the first
   * grant of a tenant-ownership (upplatelse).
   */
  transfer?: TransferInput & { fromPersonId?: string | null };
}

export interface MoveInResult {
  residencyId: string;
  /** True when this move-in wrote the statutory ENTRY row. */
  memberRegisterEntryRecorded: boolean;
  transferId: string | null;
  /** True when the welcome email was sent. */
  welcomeEmailSent: boolean;
}

export interface MoveOutInput {
  residencyId: string;
  /** ISO calendar date. */
  movedOutOn: string;
  /** Records the transfer to the acquirer, when the apartment changed hands. */
  transfer?: TransferInput & { toPersonId: string };
}

export interface MoveOutResult {
  residencyId: string;
  movedOutOn: string;
  /** Derived from the retention policy; service data is purged on this date. */
  purgeOn: string;
  /** True when this move-out ended the person's membership. */
  memberRegisterExitRecorded: boolean;
  transferId: string | null;
  /** When the board is reminded to finish the handover. */
  boardReminderOn: string;
}

/** Payload of the board's move-out reminder job. */
export interface BoardReminderJob {
  residencyId: string;
  [key: string]: unknown;
}

/** Queue the board's move-out reminder runs on. */
export const MOVE_OUT_REMINDER_QUEUE = "move-out-board-reminder";

@Injectable()
export class MoveService implements OnModuleInit {
  private readonly logger = new Logger(MoveService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly mail: MailService,
    private readonly jobs: JobQueueService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests start the worker themselves, so a job under test is
      // not raced by a worker that came up with the module.
      return;
    }
    await this.startBoardReminderWorker();
  }

  /** Registers the worker. Public so an integration test can drive the job. */
  async startBoardReminderWorker(): Promise<void> {
    await this.jobs.work<BoardReminderJob>(
      MOVE_OUT_REMINDER_QUEUE,
      async (data) => {
        await this.sendBoardMoveOutReminder(data.residencyId);
      },
    );
  }

  /**
   * Moves a person into an apartment.
   *
   * The welcome email is sent after the transaction commits rather than inside
   * it: a mail server that is slow or down must not roll back a register write,
   * and an email announcing a move-in that was rolled back is worse than one
   * that was never sent.
   */
  async moveIn(input: MoveInInput): Promise<MoveInResult> {
    const movedInOn = parseDate(input.movedInOn);

    const person = await this.prisma.person.findUnique({
      where: { id: input.personId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        postalStreet: true,
        postalCode: true,
        postalCity: true,
        emailCipher: true,
        preferredLocale: true,
      },
    });
    if (person === null) {
      throw new MoveError("No such person.", "person-not-found");
    }

    const apartment = await this.prisma.apartment.findUnique({
      where: { id: input.apartmentId },
      select: { id: true, number: true },
    });
    if (apartment === null) {
      throw new MoveError("No such apartment.", "apartment-not-found");
    }

    if (input.transfer?.fromPersonId != null) {
      await this.requirePerson(
        input.transfer.fromPersonId,
        "transfer-person-not-found",
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await lockResidencyTransitions(tx, person.id);

      const existing = await tx.residency.count({
        where: {
          personId: person.id,
          apartmentId: apartment.id,
          OR: [{ movedOutOn: null }, { movedOutOn: { gte: movedInOn } }],
        },
      });
      if (existing > 0) {
        throw new MoveError(
          "This person already has a residency on that apartment.",
          "already-resident",
        );
      }

      // Read before the insert: whether this move-in starts a membership
      // depends on whether one was already running, and the row about to be
      // created would answer its own question.
      const alreadyMember =
        input.role === "MEMBER"
          ? (await tx.residency.count({
              where: {
                personId: person.id,
                role: "MEMBER",
                OR: [{ movedOutOn: null }, { movedOutOn: { gt: movedInOn } }],
              },
            })) > 0
          : false;

      const residency = await tx.residency.create({
        data: {
          personId: person.id,
          apartmentId: apartment.id,
          role: input.role,
          movedInOn,
        },
        select: { id: true },
      });

      let memberRegisterEntryRecorded = false;
      if (input.role === "MEMBER" && !alreadyMember) {
        await tx.memberRegisterEntry.create({
          data: {
            personId: person.id,
            apartmentId: apartment.id,
            eventType: "ENTRY",
            eventOn: movedInOn,
            recordedFirstName: person.firstName,
            recordedLastName: person.lastName,
            recordedPostalStreet: person.postalStreet,
            recordedPostalCode: person.postalCode,
            recordedPostalCity: person.postalCity,
          },
        });
        memberRegisterEntryRecorded = true;
      }

      const transferId =
        input.transfer === undefined
          ? null
          : await this.recordTransfer(tx, {
              apartmentId: apartment.id,
              fromPersonId: input.transfer.fromPersonId ?? null,
              toPersonId: person.id,
              transfer: input.transfer,
            });

      return { residency, memberRegisterEntryRecorded, transferId };
    });

    // Best effort, and deliberately so: the residency and the register entry
    // have committed by now, and the ENTRY row cannot be taken back. Letting a
    // mail outage reject the request would report a written register as a
    // failure and invite a retry that cannot succeed.
    let welcomeEmailSent = false;
    try {
      welcomeEmailSent = await this.sendMoveInMail({
        emailCipher: person.emailCipher,
        locale: person.preferredLocale,
        recipientName: `${person.firstName} ${person.lastName}`.trim(),
        apartmentNumber: apartment.number,
        movedInOn,
      });
    } catch (error) {
      // The failure is named by its class and the residency, never by what it
      // was carrying: a rejection from a mail server quotes the envelope, and
      // that envelope holds an address decrypted a few lines above this.
      this.logger.error(
        `Welcome email failed for residency ${result.residency.id}: ` +
          failureName(error),
      );
    }

    this.logger.log(
      `Moved person ${person.id} into apartment ${apartment.id} as ${input.role}`,
    );

    return {
      residencyId: result.residency.id,
      memberRegisterEntryRecorded: result.memberRegisterEntryRecorded,
      transferId: result.transferId,
      welcomeEmailSent,
    };
  }

  /**
   * Moves a person out.
   *
   * The purge date is computed and returned rather than stored: it derives from
   * the association's retention policy, so a board that shortens the policy has
   * by that act moved every pending date. Storing a copy would need a job to
   * keep it true, and would be wrong until that job ran.
   */
  async moveOut(input: MoveOutInput): Promise<MoveOutResult> {
    const movedOutOn = parseDate(input.movedOutOn);

    const residency = await this.prisma.residency.findUnique({
      where: { id: input.residencyId },
      select: {
        id: true,
        role: true,
        movedInOn: true,
        movedOutOn: true,
        apartment: { select: { id: true, number: true } },
        person: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            postalStreet: true,
            postalCode: true,
            postalCity: true,
            emailCipher: true,
            preferredLocale: true,
          },
        },
      },
    });
    if (residency === null) {
      throw new MoveError("No such residency.", "residency-not-found");
    }
    if (residency.movedOutOn !== null) {
      throw new MoveError(
        "That residency already has a move-out date.",
        "already-moved-out",
      );
    }
    if (movedOutOn.getTime() < residency.movedInOn.getTime()) {
      throw new MoveError(
        "A move-out cannot precede the move-in.",
        "moved-out-before-moved-in",
      );
    }
    if (input.transfer !== undefined) {
      await this.requirePerson(
        input.transfer.toPersonId,
        "transfer-person-not-found",
      );
    }

    const person = residency.person;
    const retentionDays = await retentionDaysAfterMoveOut(this.prisma);

    // Before the transaction, because creating a queue is the queue backend's
    // own work on its own connection and has no business inside this one.
    await this.jobs.ensureQueue(MOVE_OUT_REMINDER_QUEUE);

    const result = await this.prisma.$transaction(async (tx) => {
      await lockResidencyTransitions(tx, person.id);

      // Conditional on the residency still being open, because the check above
      // ran before this transaction and is only as fresh as the moment it was
      // read. Two move-outs on the same residency both passed it, and an
      // unconditional update let both go on to append an EXIT row to a register
      // that refuses to have rows removed. The loser sees no row and is refused
      // exactly as a second sequential attempt is.
      const claimed = await tx.residency.updateMany({
        where: { id: residency.id, movedOutOn: null },
        data: { movedOutOn },
      });
      if (claimed.count === 0) {
        throw new MoveError(
          "That residency already has a move-out date.",
          "already-moved-out",
        );
      }

      // Membership ends with the LAST tenant-ownership, not with this one. A
      // member who sells one of two apartments is still a member, and an EXIT
      // row written here could never be taken back.
      const remainingMemberships =
        residency.role === "MEMBER"
          ? await tx.residency.count({
              where: {
                personId: person.id,
                role: "MEMBER",
                id: { not: residency.id },
                OR: [{ movedOutOn: null }, { movedOutOn: { gt: movedOutOn } }],
              },
            })
          : 0;

      let memberRegisterExitRecorded = false;
      if (residency.role === "MEMBER" && remainingMemberships === 0) {
        await tx.memberRegisterEntry.create({
          data: {
            personId: person.id,
            apartmentId: residency.apartment.id,
            eventType: "EXIT",
            eventOn: movedOutOn,
            recordedFirstName: person.firstName,
            recordedLastName: person.lastName,
            recordedPostalStreet: person.postalStreet,
            recordedPostalCode: person.postalCode,
            recordedPostalCity: person.postalCity,
          },
        });
        memberRegisterExitRecorded = true;
      }

      const transferId =
        input.transfer === undefined
          ? null
          : await this.recordTransfer(tx, {
              apartmentId: residency.apartment.id,
              fromPersonId: person.id,
              toPersonId: input.transfer.toPersonId,
              transfer: input.transfer,
            });

      // Enqueued by this transaction, so the reminder commits with the move-out
      // or neither does. It is the part that cannot be reconstructed: the EXIT
      // row refuses a second move-out, so a reminder lost after the commit has
      // no path back and nothing would ever notice it was missing.
      await this.scheduleBoardReminder(tx, residency.id, movedOutOn);

      return { memberRegisterExitRecorded, transferId };
    });

    const purgeOn = computePurgeDate(movedOutOn, retentionDays);
    if (purgeOn === null) {
      // computePurgeDate returns null only for a null move-out date, which
      // cannot happen here. Named rather than defaulted, because a wrong purge
      // date is a promise about erasure.
      throw new Error("A move-out with a date produced no purge date.");
    }

    try {
      await this.sendMoveOutMail({
        emailCipher: person.emailCipher,
        locale: person.preferredLocale,
        recipientName: `${person.firstName} ${person.lastName}`.trim(),
        apartmentNumber: residency.apartment.number,
        movedOutOn,
        purgeOn,
      });
    } catch (error) {
      // As with the welcome email: the class of the failure and the residency,
      // and nothing the failure was holding.
      this.logger.error(
        `Move-out notice failed for residency ${residency.id}: ` +
          failureName(error),
      );
    }

    this.logger.log(
      `Moved person ${person.id} out of apartment ${residency.apartment.id}`,
    );

    return {
      residencyId: residency.id,
      movedOutOn: isoDate(movedOutOn),
      purgeOn: isoDate(purgeOn),
      memberRegisterExitRecorded: result.memberRegisterExitRecorded,
      transferId: result.transferId,
      boardReminderOn: isoDate(movedOutOn),
    };
  }

  /**
   * Sends the board its move-out summary.
   *
   * The figures are read now rather than carried in the job payload: the purge
   * date derives from the retention policy, which the board may have changed
   * between entering the move-out and the date arriving, and a reminder stating
   * a date that no longer applies is worse than no reminder.
   */
  async sendBoardMoveOutReminder(residencyId: string): Promise<number> {
    const residency = await this.prisma.residency.findUnique({
      where: { id: residencyId },
      select: {
        movedOutOn: true,
        apartment: { select: { number: true } },
        person: { select: { firstName: true, lastName: true } },
      },
    });
    if (residency?.movedOutOn == null) {
      this.logger.warn(
        `Move-out reminder skipped: residency ${residencyId} has no move-out date.`,
      );
      return 0;
    }

    const retentionDays = await retentionDaysAfterMoveOut(this.prisma);
    const purgeOn = computePurgeDate(residency.movedOutOn, retentionDays);
    if (purgeOn === null) {
      return 0;
    }

    const now = new Date();
    const board = await this.prisma.person.findMany({
      where: {
        boardPositions: {
          some: { OR: [{ endedOn: null }, { endedOn: { gt: now } }] },
        },
        emailCipher: { not: null },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        emailCipher: true,
        preferredLocale: true,
      },
    });

    let sent = 0;
    for (const member of board) {
      if (member.emailCipher === null) {
        continue;
      }
      // Per recipient, so one unreachable address does not abandon the board
      // members after it. A rejection here would fail the whole job, and the
      // retry starts at the first board member again - the ones before the
      // failure would get the reminder twice and the ones after it never.
      try {
        const to = await this.encryption.decrypt(
          "person.email",
          member.emailCipher,
        );
        await this.mail.send({
          to,
          locale: member.preferredLocale,
          template: boardMoveOutReminderMail,
          props: {
            recipientName: `${member.firstName} ${member.lastName}`.trim(),
            personName:
              `${residency.person.firstName} ${residency.person.lastName}`.trim(),
            apartmentNumber: residency.apartment.number,
            movedOutOn: residency.movedOutOn,
            purgeOn,
          },
        });
        sent++;
      } catch (error) {
        // Named by person id and by the class of the failure, never by address
        // and never by the failure's own payload: this loop decrypts an address
        // and hands it to a mail server, and a rejection quotes it back.
        this.logger.error(
          `Move-out reminder failed for board member ${member.id}: ` +
            failureName(error),
        );
      }
    }

    this.logger.log(
      `Move-out reminder for residency ${residencyId} sent to ${String(sent)} board members`,
    );
    return sent;
  }

  private async scheduleBoardReminder(
    tx: Prisma.TransactionClient,
    residencyId: string,
    movedOutOn: Date,
  ): Promise<void> {
    await this.jobs.sendAtInTransaction<BoardReminderJob>(
      tx,
      MOVE_OUT_REMINDER_QUEUE,
      { residencyId },
      // A move-out entered after the fact is scheduled for a date already past,
      // which the queue runs at once. That is the wanted behaviour: the board
      // still has the handover in front of it.
      movedOutOn,
    );
  }

  private async requirePerson(
    personId: string,
    reason: MoveErrorReason,
  ): Promise<void> {
    const person = await this.prisma.person.findUnique({
      where: { id: personId },
      select: { id: true },
    });
    if (person === null) {
      throw new MoveError("No such person.", reason);
    }
  }

  private async recordTransfer(
    tx: Prisma.TransactionClient,
    input: {
      apartmentId: string;
      fromPersonId: string | null;
      toPersonId: string;
      transfer: TransferInput;
    },
  ): Promise<string> {
    // Refused rather than stored as null. The apartment register extract has to
    // state a reference for every transfer it lists, and this row is one the
    // database will not let anyone delete, so a transfer with nothing to point
    // at can only be answered afterwards by an entry saying the reference is
    // missing. The same requirement is a CHECK constraint on the table; this is
    // what turns it into a refusal a board can read instead of a driver error.
    const agreementReference = input.transfer.agreementReference?.trim() ?? "";
    if (agreementReference === "") {
      throw new MoveError(
        "A transfer needs a reference to its agreement.",
        "transfer-reference-required",
      );
    }

    const transfer = await tx.transfer.create({
      data: {
        apartmentId: input.apartmentId,
        fromPersonId: input.fromPersonId,
        toPersonId: input.toPersonId,
        transferredOn: parseDate(input.transfer.transferredOn),
        price: input.transfer.price ?? null,
        agreementReference,
      },
      select: { id: true },
    });
    return transfer.id;
  }

  private async sendMoveInMail(input: {
    emailCipher: string | null;
    locale: string;
    recipientName: string;
    apartmentNumber: string;
    movedInOn: Date;
  }): Promise<boolean> {
    if (input.emailCipher === null) {
      return false;
    }
    const to = await this.encryption.decrypt("person.email", input.emailCipher);
    await this.mail.send({
      to,
      locale: input.locale,
      template: moveInMail,
      props: {
        recipientName: input.recipientName,
        apartmentNumber: input.apartmentNumber,
        movedInOn: input.movedInOn,
      },
    });
    return true;
  }

  private async sendMoveOutMail(input: {
    emailCipher: string | null;
    locale: string;
    recipientName: string;
    apartmentNumber: string;
    movedOutOn: Date;
    purgeOn: Date;
  }): Promise<boolean> {
    if (input.emailCipher === null) {
      return false;
    }
    const to = await this.encryption.decrypt("person.email", input.emailCipher);
    await this.mail.send({
      to,
      locale: input.locale,
      template: moveOutMail,
      props: {
        recipientName: input.recipientName,
        apartmentNumber: input.apartmentNumber,
        movedOutOn: input.movedOutOn,
        purgeOn: input.purgeOn,
      },
    });
    return true;
  }
}

/**
 * Serializes one person's residency transitions for the length of the
 * transaction.
 *
 * Both flows decide what to write into the member register by counting the
 * person's other tenant-ownerships, and that count is read before the row that
 * would change its answer exists. Two transitions for the same person running
 * at once each read a state the other is about to invalidate: two move-ins
 * would both find no membership running and both append an ENTRY, and two
 * move-outs would each see the other's apartment as still held and neither
 * would append the EXIT. The register refuses UPDATE and DELETE, so the first
 * mistake cannot be removed and the second can only be answered by a later
 * correction row.
 *
 * An advisory lock rather than a constraint, because the invariant is "one
 * membership per person for as long as a tenant-ownership is held" and it is
 * derived from a set of residency rows. No single row carries it, so no unique
 * index can state it. Taken as the first statement in the transaction, and
 * released by the commit or the rollback with nothing left to remember to
 * unlock.
 *
 * The key is namespaced and hashed to the int4 the lock space is addressed in.
 * A collision between two persons costs one of them a short wait and nothing
 * else.
 *
 * Run through $executeRaw rather than $queryRaw because the lock function
 * returns void, which the client has no column type for.
 */
async function lockResidencyTransitions(
  tx: Prisma.TransactionClient,
  personId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`residency:${personId}`}))`;
}

/**
 * Reads a calendar date.
 *
 * Parsed as UTC midnight, matching how @db.Date columns come back, so day
 * arithmetic on a purge date cannot drift across a Swedish daylight saving
 * boundary and erase service data a day early.
 */
function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function isoDate(value: Date): string {
  const iso = value.toISOString();
  return iso.slice(0, iso.indexOf("T"));
}
