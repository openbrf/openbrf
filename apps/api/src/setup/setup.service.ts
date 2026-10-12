import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from "@nestjs/common";

import { lockPersonEmail } from "../address-book/person-email-lock";
import { AuditLogService } from "../audit/audit-log.service";
import { AuthService } from "../auth/auth.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { DomainError } from "../http/domain-error";
import {
  DEFAULT_LOCALE,
  I18nService,
  SUPPORTED_LOCALES,
} from "../i18n/i18n.service";
import { DataProtectionSeedService } from "../data-protection/data-protection-seed.service";
import { lockSystemRole } from "../roles/role-lock";
import { PagesService } from "../site/pages.service";
import { SetupClaimService } from "./setup-claim.service";

export class SetupError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "already-claimed"
      | "claim-token-invalid"
      | "invalid-email"
      | "housing-cooperative-missing",
  ) {
    super(message);
    this.status =
      reason === "invalid-email"
        ? HttpStatus.BAD_REQUEST
        : reason === "claim-token-invalid"
          ? HttpStatus.FORBIDDEN
          : HttpStatus.CONFLICT;
  }
}

/** What the sign-in surface is allowed to learn before anyone has signed in. */
export interface SetupState {
  /**
   * Whether the public first-boot path is open. Deliberately the only field:
   * this is the one unauthenticated endpoint the setup flow needs, and anything
   * else here would be information about an association's instance handed to
   * whoever loads the page.
   */
  setupRequired: boolean;
}

export interface CreateFirstAdministratorInput {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  preferredLocale?: string;
  /** The token from the setup link (ADR 0023). */
  claimToken?: string;
}

/**
 * First boot.
 *
 * The wizard is the only way an account comes into existence without an
 * invitation, which makes the question of when it is reachable a security
 * question rather than a routing one. An instance holding a statutory register
 * of personal data must never serve an open "create an administrator" form.
 *
 * The rule here is that the PUBLIC path exists only while the instance is
 * unclaimed, which means both of:
 *
 *   No account exists at all. Not "no admin account": any account means a human
 *   has been here, and the register is theirs, not the next visitor's.
 *
 *   Setup has never been completed. This is the catch for an instance whose
 *   accounts were later removed. Reopening public administrator creation on a
 *   database still full of residents' personal data would be exactly the hole
 *   this guard exists to close, so recovering from a lost sole administrator is
 *   an operator task at the database rather than something a stranger can do
 *   through a browser.
 *
 * Every other step of the wizard requires the association:manage capability, so
 * the wizard is admin-only from its second screen onwards. That is the other
 * half of the guard: the flow is not "public until finished", it is "public for
 * exactly one call on an unclaimed instance".
 *
 * And that one call needs the setup link. Whether the instance is unclaimed is
 * checked first, because the public state endpoint already says so and a
 * claimed instance has nothing left to guard with a token; then the token,
 * before anything is encrypted or written (SetupClaimService, ADR 0023).
 */
@Injectable()
export class SetupService implements OnModuleInit {
  private readonly logger = new Logger(SetupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly encryption: FieldEncryptionService,
    private readonly audit: AuditLogService,
    private readonly pages: PagesService,
    private readonly i18n: I18nService,
    // The record of processing activities, written when the wizard finishes:
    // the instance only knows what it processes once it knows who it is.
    private readonly dataProtection: DataProtectionSeedService,
    private readonly claims: SetupClaimService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the backfill themselves, so a boot does not
      // write a page into a database a suite is in the middle of arranging.
      return;
    }
    await this.backfillPrivacyNotice();
  }

  /**
   * Writes the privacy notice to an instance claimed before it existed.
   *
   * The footer of every page links the notice, so an instance that was set up
   * earlier would otherwise be the only one without it. Idempotent on the slug,
   * so it does nothing on the second boot and nothing at all to a page the
   * board has since written.
   *
   * Unclaimed instances are left alone: the wizard writes both pages when it is
   * finished, and a notice on an instance nobody has claimed would be the
   * privacy policy of no association.
   *
   * A failure is logged and swallowed. The instance is running, its website
   * answers, and refusing to start over a page that can be written on the next
   * boot would be the wrong trade.
   *
   * Public so an integration test can drive it.
   */
  async backfillPrivacyNotice(): Promise<void> {
    try {
      const association = await this.prisma.association.findUnique({
        where: { id: 1 },
        select: { defaultLocale: true, setupCompletedAt: true },
      });
      if (association?.setupCompletedAt == null) {
        return;
      }
      await this.pages.seedPrivacyNotice(
        this.i18n.translatorFor(association.defaultLocale),
      );
    } catch (cause) {
      this.logger.error(
        "The association's privacy notice could not be written. The footer " +
          "links it once it exists; this is retried on the next start.",
        cause instanceof Error ? cause.stack : undefined,
      );
    }
  }

  async state(): Promise<SetupState> {
    return { setupRequired: await this.claims.isUnclaimed() };
  }

  /**
   * Creates the first administrator: a person, the ADMIN grant, and the
   * sign-in account.
   *
   * No session is minted here. The client signs in afterwards through the
   * ordinary password path, so there is exactly one place in the codebase that
   * can hand out a session and it is the one that the rate limiting, the
   * second-factor policy and the cookie settings all apply to.
   */
  async createFirstAdministrator(
    input: CreateFirstAdministratorInput,
  ): Promise<{ personId: string }> {
    if (!(await this.claims.isUnclaimed())) {
      throw new SetupError(
        "This instance already has an account. Setup is closed.",
        "already-claimed",
      );
    }

    // A refusal writes no audit entry: there is no association yet and nobody
    // to write it against. The rate limit on the route bounds the attempts.
    if (!this.claims.matches(input.claimToken ?? "")) {
      throw new SetupError(
        "That setup link does not claim this instance.",
        "claim-token-invalid",
      );
    }
    const claimedWith = this.claims.source();

    const email = await this.encryption.encrypt("person.email", input.email);
    // Bound to a local: narrowing on a property access does not survive into
    // the transaction callback below.
    const emailIndex = email.index;
    if (emailIndex === null) {
      throw new SetupError(
        "That email address could not be read.",
        "invalid-email",
      );
    }

    const personId = await this.prisma.$transaction(async (tx) => {
      // Re-checked inside the transaction, under the lock every change to the
      // administrators takes. Two submissions at the same instant would both
      // pass the check above, and the accounts alone cannot settle which one
      // wins: the account is written after this transaction, through Better
      // Auth's adapter, which takes no transaction. The ADMIN grant is written
      // here, so it is what the second submission finds once the first commits
      // and the lock passes to it. A failed account creation removes the grant
      // again (rollbackAdministrator), so a retry is not shut out by it.
      await lockSystemRole(tx, "ADMIN");
      const accounts = await tx.user.count();
      const administrators = await tx.systemRole.count({
        where: { role: "ADMIN" },
      });
      if (accounts > 0 || administrators > 0) {
        throw new SetupError(
          "This instance already has an account. Setup is closed.",
          "already-claimed",
        );
      }

      // Taken like every other writer of a person's address takes it, though
      // nothing else can write a person before the instance is claimed.
      await lockPersonEmail(tx, emailIndex);

      const person = await tx.person.create({
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          emailCipher: email.cipher,
          emailIndex,
          preferredLocale: this.resolveLocale(input.preferredLocale),
        },
        select: { id: true },
      });

      await tx.systemRole.create({
        data: { personId: person.id, role: "ADMIN" },
      });

      // The grant is logged in the same transaction as the grant itself, so the
      // log cannot claim a role that was never given or miss one that was. The
      // actor is the new administrator: nobody else exists to have done it.
      await this.audit.record(
        {
          action: "SYSTEM_ROLE_GRANTED",
          channel: "WEB",
          actorPersonId: person.id,
          targetPersonId: person.id,
          context: { role: "ADMIN", grantedBy: "setup-wizard", claimedWith },
        },
        tx,
      );

      return person.id;
    });

    try {
      await this.auth.createAccountForPerson({
        personId,
        email: input.email,
        name: `${input.firstName} ${input.lastName}`.trim(),
        password: input.password,
      });
    } catch (cause) {
      // Without this the instance is stuck: a person holds the ADMIN grant with
      // no way to sign in, and the guard above now refuses to let anyone try
      // again. Person and grant are removed together so a retry starts clean.
      await this.rollbackAdministrator(personId);
      throw cause;
    }

    this.claims.spend();
    this.logger.log(`Created the first administrator, person ${personId}`);
    return { personId };
  }

  /**
   * Marks the wizard finished.
   *
   * Requires the association to exist, because its name is the one thing the
   * wizard cannot skip: an instance with no name for the housing cooperative
   * has nothing to put on the board or in the register stamp.
   */
  async complete(actorPersonId: string): Promise<{ completedAt: Date }> {
    const association = await this.prisma.association.findUnique({
      where: { id: 1 },
      select: {
        setupCompletedAt: true,
        name: true,
        organizationNumber: true,
        defaultLocale: true,
      },
    });

    if (association === null) {
      throw new SetupError(
        "The housing cooperative has no name yet, so setup cannot be finished.",
        "housing-cooperative-missing",
      );
    }

    // Kept, not overwritten: the first completion is when the instance was
    // claimed, and re-running the wizard from settings later does not change
    // that date.
    const completedAt = association.setupCompletedAt ?? new Date();

    await this.prisma.association.update({
      where: { id: 1 },
      data: { setupCompletedAt: completedAt },
    });

    /*
     * The association's public address starts answering here.
     *
     * A claimed instance serves its own website at the root, and an instance
     * with no page at all would answer the address its operator was given with
     * a not-found. So finishing the wizard writes one page - the cooperative's
     * name and the facts it is registered under - which the board then edits.
     *
     * It writes nothing if any page already exists, so re-running the wizard
     * from settings cannot produce a second front page or overwrite what has
     * been written since. The page is not the reason setup succeeds: a failure
     * to write it must not undo a completion that has already been stamped, so
     * it is reported rather than thrown.
     */
    try {
      const t = this.i18n.translatorFor(association.defaultLocale);
      await this.pages.seedDefaultPage(t, {
        name: association.name,
        organizationNumber: association.organizationNumber,
      });
      // Beside the front page, and for the same reason: a claimed instance
      // links its privacy notice from the footer of every page, so the page
      // that link points at has to exist from the moment the instance answers.
      await this.pages.seedPrivacyNotice(t);
    } catch (cause) {
      this.logger.error(
        "Setup finished, but the association's first pages could not be " +
          "written. The public address answers with a not-found until a page " +
          "is created.",
        cause instanceof Error ? cause.stack : undefined,
      );
    }

    /*
     * The record of processing activities (GDPR art. 30), written from what the
     * instance now knows about itself.
     *
     * Here rather than only at the next boot, which is where it would otherwise
     * happen: the association exists from this moment, and a board that opens
     * the data protection screen the same afternoon should find its own record
     * rather than an empty list with nothing saying why.
     *
     * Its own try, like the pages above. The seed swallows its own failures
     * already, and this does not lean on that: setup has been stamped, and a
     * record that can be written on the next start is not a reason to fail a
     * completion that succeeded.
     */
    try {
      await this.dataProtection.seedIfConfigured();
    } catch (cause) {
      this.logger.error(
        "Setup finished, but the record of processing activities could not " +
          "be written. It is retried on the next start.",
        cause instanceof Error ? cause.stack : undefined,
      );
    }

    this.logger.log(`Setup completed by person ${actorPersonId}`);
    return { completedAt };
  }

  /**
   * Falls back rather than failing on an unknown locale. The controller already
   * rejects one, so this only decides what an unset value means.
   */
  private resolveLocale(locale: string | undefined): string {
    return locale !== undefined &&
      (SUPPORTED_LOCALES as readonly string[]).includes(locale)
      ? locale
      : DEFAULT_LOCALE;
  }

  /**
   * Undoes a half-created administrator.
   *
   * Reported rather than thrown: the caller is already unwinding the real
   * error, and this failure needs a human rather than to replace that one.
   *
   * The account row goes first. Account creation writes the auth user and its
   * credential through Better Auth's adapter, which takes no transaction, so a
   * failure between the two can leave a user row behind whose own cleanup also
   * failed. User.person is onDelete: Restrict, so that row would block the
   * person delete below - and, because the guard counts user rows, would leave
   * setup permanently closed with nothing left able to reopen it. Removing it
   * here is the same unwind: the only account that can reference this person is
   * the one this call just tried to create, and Session, Account, TwoFactor and
   * Passkey all cascade from it.
   */
  private async rollbackAdministrator(personId: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.deleteMany({ where: { personId } });

        // The grant was logged when it was made and the log cannot be edited,
        // so its removal is recorded as its own entry. Without this the log
        // would show an administrator who was never able to sign in and whose
        // grant no longer exists, with nothing saying why.
        await this.audit.record(
          {
            action: "SYSTEM_ROLE_REVOKED",
            channel: "WEB",
            actorPersonId: personId,
            targetPersonId: personId,
            context: {
              role: "ADMIN",
              revokedBy: "setup-wizard",
              cause: "account-creation-failed",
            },
          },
          tx,
        );
        // The role before the person: it has a foreign key to the person.
        await tx.systemRole.deleteMany({ where: { personId } });
        await tx.person.delete({ where: { id: personId } });
      });
    } catch (cleanupFailure) {
      this.logger.error(
        `Could not remove the incomplete administrator ${personId}. They hold ` +
          "the ADMIN grant with no account, and setup will refuse to run " +
          "again. Recovering it by hand means deleting the auth_user row for " +
          "this person first, then the system_role row, then the person: the " +
          "account references the person with ON DELETE RESTRICT, so deleting " +
          "the person alone will fail.",
        cleanupFailure instanceof Error ? cleanupFailure.stack : undefined,
      );
    }
  }
}
