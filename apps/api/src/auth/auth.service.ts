import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from "@nestjs/common";
import { betterAuth } from "better-auth";

import { principalCan } from "../authorization/capabilities";
import { PrincipalService } from "../authorization/principal.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { failureName } from "../logging/failure";
import { MailService } from "../mail/mail.service";
import { magicLinkMail, magicLinkRefusedMail } from "../mail/templates";
import {
  buildAuthOptions,
  type ClientManagement,
  type MagicLinkDelivery,
} from "./auth-options";
import type { ProtectedResource } from "./protected-resource";
import { PROTECTED_RESOURCE } from "./protected-resource.module";

/**
 * The instance type, pinned to our concrete options.
 *
 * Without the explicit instantiation this widens to Auth<BetterAuthOptions>
 * and the typed API surface loses the declared additional fields, so
 * signUpEmail would reject the personId we require on every account.
 */
type AuthOptions = ReturnType<typeof buildAuthOptions>;
export type AuthInstance = ReturnType<typeof betterAuth<AuthOptions>>;

/**
 * How long a shutdown waits for sign-in links still being sent.
 *
 * Well inside RestartCoordinator's DRAIN_TIMEOUT_MS, which bounds the whole
 * close on a plugin-install restart: the job queue, the database connection
 * and the HTTP server close after this wait, and need time of their own.
 */
export const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Owns the Better Auth instance and the small amount of glue between it and
 * the register.
 *
 * Account creation lives here rather than in a controller because it has an
 * invariant to keep: an account exists only for a person who is already in the
 * register, and exactly one account per person.
 */
@Injectable()
export class AuthService implements OnModuleDestroy {
  private readonly logger = new Logger(AuthService.name);
  readonly instance: AuthInstance;
  /** Magic-link deliveries still running after their response. */
  private readonly deliveries = new Set<Promise<void>>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly principals: PrincipalService,
    @Inject(PROTECTED_RESOURCE) resource: ProtectedResource,
  ) {
    this.instance = betterAuth(
      buildAuthOptions(
        env,
        prisma,
        this.magicLinkDelivery(),
        resource,
        this.clientManagement(),
      ),
    );
  }

  /**
   * Settles once no magic-link delivery is running, including one started
   * while it waited: the HTTP server still answers until the application has
   * closed.
   */
  async magicLinksSettled(): Promise<void> {
    while (this.deliveries.size > 0) {
      await Promise.allSettled(this.deliveries);
    }
  }

  /**
   * Lets the magic-link deliveries still running finish before the application
   * closes, so a restart or a stopped container does not drop a sign-in link
   * whose request was already answered.
   *
   * A module-destroy hook rather than beforeApplicationShutdown, because Nest
   * runs every onModuleDestroy first and a delivery reads the database:
   * PrismaService disconnects in its own. Both modules are global, and Nest
   * destroys global modules in the reverse of the order AppModule imports
   * them, so this runs first as long as AuthModule is imported after
   * DatabaseModule and JobsModule. The integration suite closes an application
   * to hold that.
   *
   * Bounded, because a mail server that never answers must not hold the
   * shutdown past the grace period the container is given.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.deliveries.size === 0) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), SHUTDOWN_GRACE_MS);
    });
    try {
      const outcome = await Promise.race([this.magicLinksSettled(), expired]);
      if (outcome === "expired") {
        this.logger.warn(
          `${this.deliveries.size} sign-in link deliveries were still running at shutdown and were abandoned`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** The Web Fetch handler Better Auth exposes, mounted by the controller. */
  get handler(): (request: Request) => Promise<Response> {
    return this.instance.handler;
  }

  private magicLinkDelivery(): MagicLinkDelivery {
    return {
      accountState: async (email) => {
        const user = await this.prisma.user.findUnique({
          where: { email: email.toLowerCase() },
          select: { twoFactorEnabled: true },
        });
        return {
          exists: user !== null,
          hasSecondFactor: user?.twoFactorEnabled === true,
        };
      },

      send: async ({ email, url, expiresAt }) => {
        const recipient = await this.recipientFor(email);

        await this.mail.send({
          to: email,
          // The recipient's own language, not the request's.
          locale: recipient.locale,
          template: magicLinkMail,
          props: {
            recipientName: recipient.name,
            signInUrl: url,
            expiresAt,
          },
        });
      },

      sendSecondFactorNotice: async ({ email }) => {
        const recipient = await this.recipientFor(email);

        await this.mail.send({
          to: email,
          locale: recipient.locale,
          template: magicLinkRefusedMail,
          props: { recipientName: recipient.name },
        });
      },

      background: (task) => {
        const delivery = task().catch((cause: unknown) => {
          // By its class only: a mail server's refusal quotes the envelope,
          // and the envelope holds the address.
          this.logger.error(
            `A sign-in link could not be delivered: ${failureName(cause)}`,
          );
        });
        this.deliveries.add(delivery);
        void delivery.finally(() => this.deliveries.delete(delivery));
      },
    };
  }

  /**
   * Who the provider lets manage an OAuth client, over HTTP or through
   * `auth.api` - the administrator's registration route included.
   *
   * The capability `POST /api/oauth-clients` demands, derived from the register
   * by the same `PrincipalService.forPerson` the guard uses, on every call. An
   * account whose person is gone may do nothing.
   */
  private clientManagement(): ClientManagement {
    return {
      mayManageClients: async (userId) => {
        const account = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { personId: true },
        });
        if (account === null) {
          return false;
        }
        const principal = await this.principals.forPerson(account.personId);
        return (
          principal !== null && principalCan(principal, "association:manage")
        );
      },
    };
  }

  /**
   * Name and locale for an address, falling back to the address itself.
   *
   * An unknown address gets a usable answer rather than an error, because the
   * sign-in endpoint must behave identically whether or not an account exists.
   */
  private async recipientFor(
    email: string,
  ): Promise<{ name: string; locale: string | null }> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: {
        person: { select: { firstName: true, preferredLocale: true } },
      },
    });

    return {
      name: user?.person.firstName ?? email,
      locale: user?.person.preferredLocale ?? null,
    };
  }

  /**
   * Creates the sign-in account for a person who has none.
   *
   * Used by the invitation and approved-signup flows.
   *
   * This goes through Better Auth's internal adapter rather than its
   * signUpEmail endpoint, because public sign-up is disabled and that endpoint
   * honours the same switch. The sequence mirrors Better Auth's own admin
   * plugin: create the user, then link a credential account whose password is
   * hashed by Better Auth's hasher. Nothing here reimplements crypto, and the
   * stored shape is exactly what its sign-in path expects.
   *
   * The address is marked verified: the person reached this point by following
   * a link sent to that address, which is what verification would prove.
   */
  async createAccountForPerson(input: {
    personId: string;
    email: string;
    name: string;
    password: string;
  }): Promise<{ userId: string }> {
    const existing = await this.prisma.user.findUnique({
      where: { personId: input.personId },
      select: { id: true },
    });
    if (existing !== null) {
      // Typed rather than a plain Error: this is a client-visible conflict,
      // and the invitation and signup flows should answer 409 without having
      // to match on the message text.
      throw new ConflictException(
        `Person ${input.personId} already has an account; a person has at most one.`,
      );
    }

    const context = await this.instance.$context;
    const email = input.email.toLowerCase();

    const user = await context.internalAdapter.createUser(
      {
        email,
        name: input.name,
        emailVerified: true,
        personId: input.personId,
      },
      { method: "invitation" },
    );

    try {
      await context.internalAdapter.linkAccount({
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password: await context.password.hash(input.password),
      });
    } catch (cause) {
      // The two writes go through Better Auth's adapter, which takes no
      // transaction, so atomicity has to be arranged here. Without this the
      // person keeps a user row with no credential: they cannot sign in, and
      // the existence check above rejects every retry, so only a hand-written
      // DELETE would get them out of it.
      await this.deleteHalfCreatedUser(user.id, input.personId);
      throw cause;
    }

    this.logger.log(`Created account for person ${input.personId}`);
    return { userId: user.id };
  }

  /**
   * Removes a user row whose credential account never landed.
   *
   * A failure here is reported rather than thrown, because the caller is
   * already unwinding a different error and that one is the useful one. The
   * message names the row, since this is the case that needs a human.
   */
  private async deleteHalfCreatedUser(
    userId: string,
    personId: string,
  ): Promise<void> {
    try {
      await this.prisma.user.delete({ where: { id: userId } });
    } catch (cleanupFailure) {
      this.logger.error(
        `Could not remove the incomplete account ${userId} for person ` +
          `${personId}. It has no credential and blocks any retry: delete it ` +
          "by hand before inviting them again.",
        cleanupFailure instanceof Error ? cleanupFailure.stack : undefined,
      );
    }
  }

  /** Resolves the signed-in person from request headers, or null. */
  async personIdFromHeaders(headers: Headers): Promise<string | null> {
    const session = await this.instance.api.getSession({ headers });
    if (session === null) {
      return null;
    }
    const user = await this.prisma.user.findUnique({
      where: { id: session.user.id },
      select: { personId: true },
    });
    return user?.personId ?? null;
  }
}
