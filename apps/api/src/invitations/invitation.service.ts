import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { AuditLogService } from "../audit/audit-log.service";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { APP_BASE_PATH } from "../http/app-base-path";
import { MailService } from "../mail/mail.service";
import { invitationMail } from "../mail/templates";

/** How long an invitation stays valid. Long enough for a holiday. */
const INVITATION_TTL_DAYS = 14;

export class InvitationError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "person-not-found"
      | "no-email"
      | "already-has-account"
      | "invalid-token"
      | "expired"
      | "already-accepted",
  ) {
    super(message);
    this.name = "InvitationError";
  }
}

/**
 * Invitation-based account activation.
 *
 * This is the only route to an account other than the first admin and an
 * approved self-signup request, and it works identically for residents, board
 * members and external admins: all of them are persons in the register first,
 * and an invitation only ever activates an account for a person who already
 * exists.
 *
 * The token is stored as a SHA-256 hash. The plaintext exists only in the email,
 * so a leaked database yields no usable invitations. SHA-256 without a salt is
 * the right choice here, unlike for a password: the token is 32 random bytes,
 * so there is no dictionary to attack and the lookup must stay a single indexed
 * query.
 */
@Injectable()
export class InvitationService {
  private readonly logger = new Logger(InvitationService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly mail: MailService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Creates an invitation for a person and emails the activation link.
   *
   * Re-inviting is allowed and replaces any outstanding invitation, so a lost
   * email does not leave the person permanently stuck, and the previous link
   * stops working.
   */
  async invite(input: {
    personId: string;
    invitedByPersonId: string | null;
  }): Promise<{ expiresAt: Date }> {
    const person = await this.prisma.person.findUnique({
      where: { id: input.personId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        emailCipher: true,
        preferredLocale: true,
        userAccount: { select: { id: true } },
      },
    });

    if (person === null) {
      throw new InvitationError(
        `No person with id ${input.personId}.`,
        "person-not-found",
      );
    }
    if (person.userAccount !== null) {
      throw new InvitationError(
        "This person already has an account.",
        "already-has-account",
      );
    }
    if (person.emailCipher === null) {
      throw new InvitationError(
        "This person has no email address, so no invitation can be sent.",
        "no-email",
      );
    }

    const email = await this.encryption.decrypt(
      "person.email",
      person.emailCipher,
    );

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(
      Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    await this.prisma.$transaction(async (tx) => {
      // Supersede any outstanding invitation so only the newest link works.
      await tx.invitation.deleteMany({
        where: { personId: person.id, acceptedAt: null },
      });
      await tx.invitation.create({
        data: {
          personId: person.id,
          tokenHash: hashToken(token),
          expiresAt,
          invitedById: input.invitedByPersonId,
        },
      });

      /*
       * In the transaction that issues the link, not after the mail is
       * accepted. What is recorded is that an invitation now exists for this
       * person - which is exactly what the row says - so the two commit
       * together. A mail server that refuses the message afterwards leaves an
       * outstanding invitation and an entry that says so, and the board's
       * answer to that is to send it again.
       */
      await this.audit.record(
        {
          action: "INVITATION_SENT",
          actorPersonId: input.invitedByPersonId,
          targetPersonId: person.id,
          context: { expiresAt: expiresAt.toISOString() },
        },
        tx,
      );
    });

    await this.mail.send({
      to: email,
      locale: person.preferredLocale,
      template: invitationMail,
      props: {
        recipientName: person.firstName,
        activationUrl: this.activationUrl(token),
        expiresAt,
      },
    });

    this.logger.log(`Invited person ${person.id}`);
    return { expiresAt };
  }

  /**
   * Activates the account for a valid invitation token.
   *
   * The invitation is consumed in the same transaction as its audit entry and
   * nothing else: account creation goes through Better Auth, which owns its own
   * tables, so those two steps are ordered rather than atomic. The order
   * matters - create the account first, mark the invitation accepted second -
   * because a failure between them leaves a usable invitation rather than an
   * unreachable account.
   *
   * The email address the account was created for is returned so the caller can
   * sign in with it straight away. See the note on the controller for why
   * handing it back is safe.
   */
  async accept(input: {
    token: string;
    password: string;
  }): Promise<{ personId: string; email: string }> {
    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashToken(input.token) },
      select: {
        id: true,
        personId: true,
        expiresAt: true,
        acceptedAt: true,
        person: {
          select: {
            firstName: true,
            lastName: true,
            emailCipher: true,
            userAccount: { select: { id: true } },
          },
        },
      },
    });

    if (invitation === null) {
      throw new InvitationError("This link is not valid.", "invalid-token");
    }
    if (invitation.acceptedAt !== null) {
      throw new InvitationError(
        "This link has already been used.",
        "already-accepted",
      );
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new InvitationError("This link has expired.", "expired");
    }
    if (invitation.person.userAccount !== null) {
      throw new InvitationError(
        "This person already has an account.",
        "already-has-account",
      );
    }
    if (invitation.person.emailCipher === null) {
      throw new InvitationError(
        "This person has no email address.",
        "no-email",
      );
    }

    const email = await this.encryption.decrypt(
      "person.email",
      invitation.person.emailCipher,
    );

    await this.auth.createAccountForPerson({
      personId: invitation.personId,
      email,
      name: `${invitation.person.firstName} ${invitation.person.lastName}`,
      password: input.password,
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });

      // The person acts on themselves here: the token is what identifies them,
      // and there is no session yet for the guard to have resolved.
      await this.audit.record(
        {
          action: "INVITATION_ACCEPTED",
          actorPersonId: invitation.personId,
          targetPersonId: invitation.personId,
        },
        tx,
      );
    });

    this.logger.log(`Person ${invitation.personId} activated their account`);
    return { personId: invitation.personId, email };
  }

  private activationUrl(token: string): string {
    // Under the application's prefix: the root is the association's own public
    // website, and a link mailed to a recipient's inbox outlives any redirect
    // we might put there.
    const url = new URL(`${APP_BASE_PATH}/activate`, this.env.APP_URL);
    url.searchParams.set("token", token);
    return url.toString();
  }
}

/**
 * Hashes an invitation token for storage and lookup.
 *
 * Exported so tests can assert the plaintext is never persisted.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Constant-time comparison, for callers that need to compare two tokens
 * directly rather than by indexed lookup.
 */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
