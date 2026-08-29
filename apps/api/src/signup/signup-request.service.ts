import { Injectable, Logger } from "@nestjs/common";

import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { InvitationService } from "../invitations/invitation.service";

export class SignupRequestError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "self-signup-disabled"
      | "invalid-email"
      | "not-found"
      | "already-decided"
      | "apartment-not-found"
      | "already-has-account",
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

    const request = await this.prisma.$transaction(async (tx) => {
      // One outstanding request per email address: resubmitting from the same
      // address replaces the old one rather than filling the board's queue
      // with duplicates.
      await tx.signupRequest.deleteMany({
        where: { emailIndex, status: "PENDING" },
      });
      return tx.signupRequest.create({
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
    });

    this.logger.log(`Received signup request ${request.id}`);
    return request;
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
   * An existing person is matched by email rather than by name, and the match
   * is computed from the plaintext against the person-scoped blind index. The
   * two stored indexes are not comparable directly: CipherSweet derives a
   * separate key per table and field, so the request's own index would never
   * equal the person's.
   */
  async approve(input: {
    requestId: string;
    apartmentId: string;
    decidedByPersonId: string;
    role?: "MEMBER" | "RESIDENT";
  }): Promise<{ personId: string }> {
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

    const existing =
      personEmailIndex === null
        ? null
        : await this.prisma.person.findFirst({
            where: { emailIndex: personEmailIndex },
            select: { id: true, userAccount: { select: { id: true } } },
          });

    if (existing?.userAccount != null) {
      throw new SignupRequestError(
        "That address already has an account.",
        "already-has-account",
      );
    }

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

      await tx.residency.create({
        data: {
          personId: id,
          apartmentId: apartment.id,
          // A self-signup never grants membership: holding a tenant-ownership
          // is a matter of record, not of asking.
          role: input.role ?? "RESIDENT",
          movedInOn: new Date(),
        },
      });

      return id;
    });

    await this.invitations.invite({
      personId,
      invitedByPersonId: input.decidedByPersonId,
    });

    this.logger.log(`Approved signup request ${request.id}`);
    return { personId };
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

    // Conditional for the same reason as in approve: the check above does not
    // survive two concurrent rejections, this does.
    const decided = await this.prisma.signupRequest.updateMany({
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
  }
}
