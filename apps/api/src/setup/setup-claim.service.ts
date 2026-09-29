import { randomBytes } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";

import { hashOpaqueToken, tokensMatch } from "../auth/opaque-token";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { applicationUrl } from "../http/app-base-path";
import { failureFrames, failureName } from "../logging/failure";

/**
 * Where the token that claimed the instance came from, as the audit entry of
 * the first administrator's grant records it: the host's digest in the
 * environment, or the link this process printed to its log.
 */
export type ClaimSource = "environment" | "log";

/**
 * Who may claim a fresh instance (ADR 0023).
 *
 * An unclaimed instance creates its first administrator for whoever calls the
 * one public write first, and an instance is reachable from the moment it
 * listens: a hosted one at a name that is public before anybody opens it, a
 * self-hosted one behind whatever the operator has put in front of it. So the
 * call takes a token as well, and only the holder of the setup link has it.
 *
 * The token arrives one of two ways:
 *
 *   From the host. OPENBRF_SETUP_TOKEN_DIGEST is the digest of a token the
 *   host minted and handed to the board as the link. The instance never sees
 *   the token until somebody presents it.
 *
 *   From this process. With no digest configured, an unclaimed instance draws
 *   a token when it starts, keeps only its digest, in memory, and prints the
 *   link to its log - where the operator who started it reads it. Nothing is
 *   written anywhere else: there is nothing to migrate or back up, and a
 *   restart draws a new token, which is also what ends a link that leaked.
 *
 * A token in a log is a credential in a log, collected and kept on the
 * operator's schedule (ADR 0007). What it opens is an instance that holds no
 * data yet, and only until the claim or the next restart, whichever comes
 * first; the line says so.
 */
@Injectable()
export class SetupClaimService {
  private readonly logger = new Logger(SetupClaimService.name);

  /** The digest of the token this process printed, until it is spent. */
  private minted: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * True while no account exists and setup has never been completed.
   *
   * The rule SetupService states, held here because the announcement at start
   * asks the same question and must get the same answer.
   */
  async isUnclaimed(): Promise<boolean> {
    const [accounts, association] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.association.findUnique({
        where: { id: 1 },
        select: { setupCompletedAt: true },
      }),
    ]);

    return accounts === 0 && association?.setupCompletedAt == null;
  }

  /**
   * Says, once the server listens, whether and how this instance can be
   * claimed.
   *
   * Called from main.ts after listen and from nowhere else, so only the
   * process that serves the wizard ever mints: the CLI has an entry of its own
   * and a token it printed would open nothing. A second call mints nothing
   * new, because the link already printed is the one the operator is reading.
   *
   * A failure to read the claimed state is logged and swallowed. The instance
   * is serving its website and its members, and the line says what to do.
   */
  async announce(): Promise<void> {
    let unclaimed: boolean;
    try {
      unclaimed = await this.isUnclaimed();
    } catch (cause) {
      this.logger.error(
        "Could not read whether this instance is claimed, so no setup link " +
          `was printed: ${failureName(cause)}. Restart the instance to try ` +
          "again.",
        failureFrames(cause),
      );
      return;
    }
    if (!unclaimed) {
      return;
    }

    if (this.env.OPENBRF_SETUP_TOKEN_DIGEST !== undefined) {
      // The host holds the link. Nothing here could print it, and printing the
      // digest would help nobody but somebody searching the log for a value.
      this.logger.log(
        "This instance is unclaimed and waits for its setup link.",
      );
      return;
    }
    if (this.minted !== null) {
      return;
    }

    const token = randomBytes(32).toString("base64url");
    this.minted = hashOpaqueToken(token);
    this.logger.log(
      `This instance is unclaimed. Open ${applicationUrl(this.env.APP_URL)}` +
        `/setup#claim=${token} to create the first administrator. The link ` +
        "works until the instance is claimed or restarted.",
    );
  }

  /**
   * Whether a presented token is the one that may claim the instance.
   *
   * False while nothing is expected yet: a request that reaches the route
   * before this process has minted is refused rather than let through, and
   * its sender uses the link once it is printed.
   */
  matches(token: string): boolean {
    const expected = this.env.OPENBRF_SETUP_TOKEN_DIGEST ?? this.minted;
    if (expected === null) {
      return false;
    }
    return tokensMatch(hashOpaqueToken(token), expected);
  }

  /** Where a token that matches came from. */
  source(): ClaimSource {
    return this.env.OPENBRF_SETUP_TOKEN_DIGEST === undefined
      ? "log"
      : "environment";
  }

  /**
   * Ends the printed link once it has claimed the instance.
   *
   * The claimed state already refuses every later claim; this makes the token
   * worth nothing on its own as well, rather than for as long as the process
   * lives. A digest from the environment is the host's to retire.
   */
  spend(): void {
    this.minted = null;
  }
}
