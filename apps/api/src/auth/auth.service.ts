import { ConflictException, Inject, Injectable, Logger } from "@nestjs/common";
import { betterAuth } from "better-auth";
import { createLocalAccountIssuer } from "better-auth/db";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { MailService } from "../mail/mail.service";
import { magicLinkMail, magicLinkRefusedMail } from "../mail/templates";
import { buildAuthOptions, type MagicLinkDelivery } from "./auth-options";

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
 * Owns the Better Auth instance and the small amount of glue between it and
 * the register.
 *
 * Account creation lives here rather than in a controller because it has an
 * invariant to keep: an account exists only for a person who is already in the
 * register, and exactly one account per person.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  readonly instance: AuthInstance;

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {
    this.instance = betterAuth(
      buildAuthOptions(env, prisma, this.magicLinkDelivery()),
    );
  }

  /** The Web Fetch handler Better Auth exposes, mounted by the controller. */
  get handler(): (request: Request) => Promise<Response> {
    return this.instance.handler;
  }

  private magicLinkDelivery(): MagicLinkDelivery {
    return {
      hasSecondFactor: async (email) => {
        const user = await this.prisma.user.findUnique({
          where: { email: email.toLowerCase() },
          select: { twoFactorEnabled: true },
        });
        return user?.twoFactorEnabled === true;
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

    await context.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "credential",
      issuer: createLocalAccountIssuer("credential"),
      accountId: user.id,
      password: await context.password.hash(input.password),
    });

    this.logger.log(`Created account for person ${input.personId}`);
    return { userId: user.id };
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
