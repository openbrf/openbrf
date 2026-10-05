import { Injectable, Logger } from "@nestjs/common";
import { dateColumnOf, localDayOf } from "@openbrf/shared";

import { lockPersonEmail } from "../address-book/person-email-lock";
import { AuditLogService } from "../audit/audit-log.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import { droppedSubmissionId } from "../http/honeypot";
import { InvitationService } from "../invitations/invitation.service";
import { failureName } from "../logging/failure";
import { MoveService } from "../moves/move.service";
import { lockApartmentResidencies } from "../registers/residency-lock";

export class SignupRequestError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "self-signup-disabled"
      | "invalid-email"
      | "not-found"
      | "already-decided"
      | "apartment-not-found"
      | "already-has-account"
      | "email-shared",
  ) {
    super(message);
    this.name = "SignupRequestError";
  }
}

export interface SubmitSignupRequestInput {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string;
  /** Free text, as typed by the visitor. */
  claimedAddress: string;
  claimedApartmentNumber: string;
}

/**
 * Board-approved self-signup.
 *
 * The flow exists so a resident the board has not yet entered can ask for
 * access, without turning the instance into open registration: a request
 * creates nothing but the request itself, and only an approval produces a
 * person, a residency and an invitation.
 *
 * The address and apartment are captured as free text on purpose. The form is
 * served before sign-in, and everything on this platform sits behind a login
 * (decision 28), so it must not offer a picker that enumerates the association's
 * addresses and apartments to anyone who loads the page. Matching the claim to a
 * real apartment is the board's job at approval time, where a human can see
 * whether the claim is plausible.
 */
@Injectable()
export class SignupRequestService {
  private readonly logger = new Logger(SignupRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
    private readonly invitations: InvitationService,
    private readonly audit: AuditLogService,
    private readonly moves: MoveService,
  ) {}

  /**
   * Whether this instance is accepting sign-up requests at all.
   *
   * The public form asks before it renders, so a visitor is told the door is
   * closed rather than offered a form whose every submission would be refused.
   * It discloses nothing new: submit already answers self-signup-disabled to an
   * anonymous caller before it validates anything, so the boolean is readable
   * from the outside either way. Everything else about the association stays
   * behind a login (decision 28).
   */
  async state(): Promise<{ enabled: boolean }> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { selfSignupEnabled: true },
    });

    return { enabled: association?.selfSignupEnabled === true };
  }

  async submit(input: SubmitSignupRequestInput): Promise<{ id: string }> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: { selfSignupEnabled: true },
    });

    if (association?.selfSignupEnabled !== true) {
      throw new SignupRequestError(
        "This association does not accept sign-up requests.",
        "self-signup-disabled",
      );
    }

    const email = await this.encryption.encrypt(
      "signupRequest.email",
      input.email,
    );
    // Bound to a local: narrowing on a property access does not survive into
    // the transaction callback below.
    const emailIndex = email.index;
    if (emailIndex === null) {
      // Without an index a duplicate request could not be detected, and the
      // address could never be matched to a person. That is a validation
      // failure rather than something to store unsearchably.
      throw new SignupRequestError(
        "That email address could not be read.",
        "invalid-email",
      );
    }
    const phone =
      input.phone === undefined
        ? null
        : await this.encryption.encrypt("person.phone", input.phone);

    /*
     * One outstanding request per email address, and it is the first one. A
     * later submission from the same address is answered exactly as a stored
     * one is and stored nowhere: the form is anonymous, so replacing the
     * request would let anybody who knows a resident's address swap the claim
     * the board reads for one of their own. A resident who mistyped theirs
     * asks the board to reject it and submits again.
     *
     * The read is a fast path; the partial unique index on the address of a
     * pending request decides two submissions arriving together.
     */
    const outstanding = await this.prisma.signupRequest.count({
      where: { emailIndex, status: "PENDING" },
    });
    if (outstanding > 0) {
      return { id: droppedSubmissionId() };
    }

    try {
      const request = await this.prisma.signupRequest.create({
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          emailCipher: email.cipher,
          emailIndex,
          phoneCipher: phone?.cipher ?? null,
          claimedAddress: input.claimedAddress,
          claimedApartmentNumber: input.claimedApartmentNumber,
        },
        select: { id: true },
      });
      this.logger.log(`Received signup request ${request.id}`);
      return request;
    } catch (cause) {
      if (
        cause instanceof Prisma.PrismaClientKnownRequestError &&
        cause.code === "P2002"
      ) {
        return { id: droppedSubmissionId() };
      }
      throw cause;
    }
  }

  /** The board's queue. Contact details stay encrypted until decrypted here. */
  async listPending(): Promise<
    {
      id: string;
      firstName: string;
      lastName: string;
      email: string;
      claimedAddress: string;
      claimedApartmentNumber: string;
      createdAt: Date;
    }[]
  > {
    const requests = await this.prisma.signupRequest.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
    });

    return Promise.all(
      requests.map(async (request) => ({
        id: request.id,
        firstName: request.firstName,
        lastName: request.lastName,
        email: await this.encryption.decrypt(
          "signupRequest.email",
          request.emailCipher,
        ),
        claimedAddress: request.claimedAddress,
        claimedApartmentNumber: request.claimedApartmentNumber,
        createdAt: request.createdAt,
      })),
    );
  }

  /**
   * Approves a request: creates or links the person, records the residency and
   * sends the activation invitation.
   *
   * The residency is always a resident's. A self-signup never grants
   * membership: holding a tenant-ownership is a matter of record, entered by
   * a move-in with its transfer, and a membership that began here would have
   * no ENTRY in the member register and no transfer behind it.
   *
   * An existing person is matched by email rather than by name, and the match
   * is computed from the plaintext against the person-scoped blind index. The
   * two stored indexes are not comparable directly: CipherSweet derives a
   * separate key per table and field, so the request's own index would never
   * equal the person's. The match is made inside the approval's transaction,
   * under the lock every writer of a person's address takes (see
   * `person-email-lock.ts`).
   *
   * The invitation goes out after the commit. A mail server that refuses it
   * does not undo the approval, which has been recorded by then, so the answer
   * says whether it was sent and the board re-invites from the address book.
   */
  async approve(input: {
    requestId: string;
    apartmentId: string;
    decidedByPersonId: string;
  }): Promise<{ personId: string; invitationSent: boolean }> {
    const request = await this.prisma.signupRequest.findUnique({
      where: { id: input.requestId },
    });
    if (request === null) {
      throw new SignupRequestError("No such request.", "not-found");
    }
    if (request.status !== "PENDING") {
      throw new SignupRequestError(
        "This request has already been decided.",
        "already-decided",
      );
    }

    const apartment = await this.prisma.apartment.findUnique({
      where: { id: input.apartmentId },
      select: { id: true },
    });
    if (apartment === null) {
      throw new SignupRequestError("No such apartment.", "apartment-not-found");
    }

    const email = await this.encryption.decrypt(
      "signupRequest.email",
      request.emailCipher,
    );
    const personEmailIndex = await this.encryption.computeIndex(
      "person.email",
      email,
    );

    const personId = await this.prisma.$transaction(async (tx) => {
      // The PENDING check above is only a fast path: two boards clicking
      // approve at the same moment both pass it. This conditional update is
      // what actually decides the race. Postgres re-evaluates the WHERE clause
      // once it has the row lock, so the second transaction matches no row and
      // rolls back rather than creating a second person, residency and
      // invitation for one request.
      const claimed = await tx.signupRequest.updateMany({
        where: { id: request.id, status: "PENDING" },
        data: {
          status: "APPROVED",
          decidedAt: new Date(),
          decidedById: input.decidedByPersonId,
          matchedApartmentId: apartment.id,
        },
      });
      if (claimed.count === 0) {
        throw new SignupRequestError(
          "This request has already been decided.",
          "already-decided",
        );
      }

      /*
       * The match is made here, under the address's lock, and not before the
       * transaction: a person the board adds with the same address while this
       * runs would otherwise commit after the read, and the approval would
       * enter the applicant a second time beside them. The apartment's lock
       * comes first because the move-in below takes it, and every transaction
       * takes it before any other key.
       */
      await lockApartmentResidencies(tx, apartment.id);
      if (personEmailIndex !== null) {
        await lockPersonEmail(tx, personEmailIndex);
      }

      /*
       * Every person on the address, not the first one. A household can share
       * one, so the index is not unique: linking to whichever row came back
       * first could attach the applicant to their partner's record, and miss
       * the one that already has an account. Two is enough to tell.
       *
       * A refusal here rolls the claim above back, so the request stays
       * pending for the board to reject or approve against another person.
       */
      const matches =
        personEmailIndex === null
          ? []
          : await tx.person.findMany({
              where: { emailIndex: personEmailIndex },
              select: { id: true, userAccount: { select: { id: true } } },
              take: 2,
            });

      if (matches.some((match) => match.userAccount !== null)) {
        throw new SignupRequestError(
          "That address already has an account.",
          "already-has-account",
        );
      }
      if (matches.length > 1) {
        throw new SignupRequestError(
          "More than one person in the register has that address.",
          "email-shared",
        );
      }
      const existing = matches[0];

      let id = existing?.id;

      if (id === undefined) {
        const encryptedEmail = await this.encryption.encrypt(
          "person.email",
          email,
        );
        const created = await tx.person.create({
          data: {
            firstName: request.firstName,
            lastName: request.lastName,
            emailCipher: encryptedEmail.cipher,
            emailIndex: encryptedEmail.index,
            phoneCipher: request.phoneCipher,
          },
          select: { id: true },
        });
        id = created.id;
      }

      /*
       * Through the move-in's own rules, in this transaction: the apartment's
       * lock and the person's transition lock, the refusal of a second
       * residency on the apartment for a person matched by email, and the
       * close of an erasure request the move-in overtakes. Dated by the
       * calendar day in Stockholm (ADR 0013), not by the UTC instant, which is
       * the day before for the first hours after midnight in summer.
       */
      await this.moves.enterResidency(tx, {
        actorPersonId: input.decidedByPersonId,
        personId: id,
        apartmentId: apartment.id,
        role: "RESIDENT",
        movedInOn: dateColumnOf(localDayOf(new Date())),
      });

      /*
       * In the transaction that claims the request, so the decision and the
       * record of it commit together: a second board member losing the race
       * above rolls back without leaving an entry for a decision they did not
       * make. Both the request and the person are named - the request because
       * it is what was decided, the person because a later data subject access
       * report is asked by person.
       */
      await this.audit.record(
        {
          action: "SIGNUP_REQUEST_APPROVED",
          channel: "WEB",
          actorPersonId: input.decidedByPersonId,
          targetPersonId: id,
          targetKind: "signupRequest",
          targetId: request.id,
          context: {
            apartmentId: apartment.id,
            role: "RESIDENT",
            personExisted: existing !== undefined,
          },
        },
        tx,
      );

      return id;
    });

    let invitationSent = false;
    try {
      await this.invitations.invite({
        personId,
        invitedByPersonId: input.decidedByPersonId,
      });
      invitationSent = true;
    } catch (cause) {
      // Named by its class only: a mail server's refusal quotes the envelope,
      // and the envelope holds the address decrypted above.
      this.logger.warn(
        `Approved signup request ${request.id}, but the invitation was not sent: ${failureName(cause)}`,
      );
    }

    this.logger.log(`Approved signup request ${request.id}`);
    return { personId, invitationSent };
  }

  async reject(input: {
    requestId: string;
    decidedByPersonId: string;
    reason?: string;
  }): Promise<void> {
    const request = await this.prisma.signupRequest.findUnique({
      where: { id: input.requestId },
      select: { status: true },
    });
    if (request === null) {
      throw new SignupRequestError("No such request.", "not-found");
    }
    if (request.status !== "PENDING") {
      throw new SignupRequestError(
        "This request has already been decided.",
        "already-decided",
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // Conditional for the same reason as in approve: the check above does not
      // survive two concurrent rejections, this does.
      const decided = await tx.signupRequest.updateMany({
        where: { id: input.requestId, status: "PENDING" },
        data: {
          status: "REJECTED",
          decidedAt: new Date(),
          decidedById: input.decidedByPersonId,
          rejectReason: input.reason ?? null,
        },
      });
      if (decided.count === 0) {
        throw new SignupRequestError(
          "This request has already been decided.",
          "already-decided",
        );
      }

      /*
       * No person is named: a rejected request produced none, and the
       * applicant is not in the register.
       *
       * The reason the board typed is on the request row and is named here
       * rather than copied. The audit log is append-only and outside every
       * purge scope, so a copy would keep the board's words about an applicant
       * after the request itself was erased, and would keep the first version
       * of them if the row were ever corrected - see the retention rule on
       * AuditLogService. Whether a reason was given is a fact about the
       * decision and stays; the text is read from the request.
       */
      await this.audit.record(
        {
          action: "SIGNUP_REQUEST_REJECTED",
          channel: "WEB",
          actorPersonId: input.decidedByPersonId,
          targetKind: "signupRequest",
          targetId: input.requestId,
          context: { reasonGiven: input.reason !== undefined },
        },
        tx,
      );
    });
  }
}
