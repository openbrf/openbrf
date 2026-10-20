import { randomBytes } from "node:crypto";

import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { SupportAccessHours } from "@openbrf/shared";

import { type ActorContext, auditActor } from "../audit/actor-context";
import { AuditLogService } from "../audit/audit-log.service";
import { hashOpaqueToken } from "../auth/opaque-token";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { applicationUrl } from "../http/app-base-path";
import {
  SupportAccessClosedError,
  SupportAccessOpenError,
  SupportSignInInvalidError,
} from "./support-errors";

/** The longest supporter's name the host may give, in characters. */
export const SUPPORTER_NAME_MAX_LENGTH = 80;

/** How long a sign-in link works once issued. */
const SIGN_IN_LINK_MS = 10 * 60 * 1000;

/** How long a support session lasts at most, from the moment it started. */
const SESSION_MS = 8 * 60 * 60 * 1000;

/** How many accesses the settings screen lists, newest first. */
const HISTORY_LENGTH = 20;

const HOUR_MS = 60 * 60 * 1000;

/** What a request under a support session acts as, once resolved. */
export interface SupportSessionContext {
  readonly sessionId: string;
  readonly accessId: string;
  /** The administrator who opened the access, on whose instruction it acts. */
  readonly openedById: string;
  readonly supporter: string;
  /** When the session stops working: its own end or the access's. */
  readonly endsAt: Date;
}

/** A sign-in link the host asked for, as the management API answers it. */
export interface IssuedSupportSignIn {
  readonly signInUrl: string;
  readonly expiresAt: Date;
  readonly accessEndsAt: Date;
}

/** Whether an access is open, and if not, why it stopped. */
export type SupportAccessState =
  | "open"
  /** An administrator closed it. */
  | "closed"
  /** It reached its end time. */
  | "ended"
  /** Whoever opened it no longer holds the administrator grant. */
  | "lapsed";

export interface SupportPersonView {
  personId: string;
  /** Null when the person is no longer in the register. */
  name: string | null;
}

export interface SupportSessionView {
  id: string;
  supporter: string;
  issuedAt: string;
  startedAt: string | null;
  expiresAt: string | null;
  endedAt: string | null;
}

export interface SupportAccessView {
  id: string;
  state: SupportAccessState;
  openedAt: string;
  openedBy: SupportPersonView;
  endsAt: string;
  closedAt: string | null;
  closedBy: SupportPersonView | null;
  sessions: SupportSessionView[];
}

export interface SupportAccessOverview {
  /** The access that is open now, if one is. */
  open: SupportAccessView | null;
  /** The latest accesses, newest first, the open one among them. */
  accesses: SupportAccessView[];
}

const ACCESS_WITH_SESSIONS = {
  sessions: { orderBy: { issuedAt: "asc" } },
} as const satisfies Prisma.SupportAccessInclude;

type AccessWithSessions = Prisma.SupportAccessGetPayload<{
  include: typeof ACCESS_WITH_SESSIONS;
}>;

/**
 * Support access the administrator opens (ADR 0028).
 *
 * An administrator opens it for a stated time with a reason, and any
 * administrator may close it. While it is open, whoever hosts the instance can
 * ask the management API for a single-use sign-in link, and a supporter who
 * uses the link gets a support session: not an account, never a person in the
 * register, read only, and in the audit log on every request.
 *
 * "Open" is asked of the clock and the register every time rather than stored:
 * not closed, not past its end, and the ADMIN grant it was opened under still
 * exists. The last is the access lasting no longer than the grant of whoever
 * gave it, and it is read on every request for the reason PrincipalService
 * derives roles on every request: a stale copy keeps granting access after the
 * reason for it has expired. The grant itself rather than whether its holder is
 * an administrator today, so that a demotion ends the access for good and a
 * later appointment does not revive it.
 *
 * Opening, closing and issuing a link take the same advisory lock, so two
 * administrators opening at once get one access and a 409, and a link is not
 * issued for an access that a concurrent close has just ended.
 *
 * Neither token is kept. Each is 32 random bytes, and the table holds its
 * SHA-256 digest (`hashOpaqueToken`), so a backup of the database cannot be
 * used to sign in.
 */
@Injectable()
export class SupportAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Opens support access, or refuses because one is open already. */
  async open(
    actor: ActorContext,
    input: { hours: SupportAccessHours; reason: string },
  ): Promise<SupportAccessView> {
    const id = await this.prisma.$transaction(async (tx) => {
      await lockSupportAccess(tx);
      const now = new Date();
      if ((await openAccess(tx, now)) !== null) {
        throw new SupportAccessOpenError();
      }
      /*
       * association:manage is the administrator's alone today, so this only
       * refuses if that ever changes: the access is the administrator's
       * instruction, and it is held to the grant they act under.
       */
      const grant = await tx.systemRole.findUnique({
        where: { personId_role: { personId: actor.personId, role: "ADMIN" } },
        select: { id: true },
      });
      if (grant === null) {
        throw new ForbiddenException(
          "Only an administrator can open support access.",
        );
      }
      const endsAt = new Date(now.getTime() + input.hours * HOUR_MS);
      const access = await tx.supportAccess.create({
        data: {
          openedById: actor.personId,
          openedUnderGrantId: grant.id,
          openedAt: now,
          endsAt,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          action: "SUPPORT_ACCESS_OPENED",
          ...auditActor(actor),
          targetKind: "supportAccess",
          targetId: access.id,
          /*
           * The reason is text with no other home: it is typed into a field
           * whose only destination is this entry, and the form says it is kept
           * for good (the retention rule on AuditLogService).
           */
          context: {
            endsAt: endsAt.toISOString(),
            hours: input.hours,
            reason: input.reason,
          },
        },
        tx,
      );
      return access.id;
    });
    return this.view(id);
  }

  /** Closes the open access, ending every session under it. */
  async close(actor: ActorContext, accessId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockSupportAccess(tx);
      const open = await openAccess(tx, new Date());
      if (open === null || open.id !== accessId) {
        throw new SupportAccessClosedError();
      }
      await tx.supportAccess.update({
        where: { id: accessId },
        data: { closedAt: new Date(), closedById: actor.personId },
      });
      await this.audit.record(
        {
          action: "SUPPORT_ACCESS_CLOSED",
          ...auditActor(actor),
          targetKind: "supportAccess",
          targetId: accessId,
        },
        tx,
      );
    });
  }

  /** The open access, if any, and the ones before it. */
  async overview(): Promise<SupportAccessOverview> {
    const rows = await this.prisma.supportAccess.findMany({
      orderBy: { openedAt: "desc" },
      take: HISTORY_LENGTH,
      include: ACCESS_WITH_SESSIONS,
    });
    const accesses = await this.views(rows);
    return {
      open: accesses.find((access) => access.state === "open") ?? null,
      accesses,
    };
  }

  /**
   * A sign-in link for the supporter the host names, while an access is open.
   *
   * The management API's one write: a session row holding the digest of the
   * link's token, and the entry that records the host asked. Refused when no
   * access is open, which is the second key - a management token alone gets
   * nothing.
   */
  async issueSignIn(supporter: string): Promise<IssuedSupportSignIn> {
    const token = randomBytes(32).toString("base64url");
    return this.prisma.$transaction(async (tx) => {
      await lockSupportAccess(tx);
      const now = new Date();
      const access = await openAccess(tx, now);
      if (access === null) {
        throw new SupportAccessClosedError();
      }
      const expiresAt = new Date(now.getTime() + SIGN_IN_LINK_MS);
      const session = await tx.supportSession.create({
        data: {
          accessId: access.id,
          supporter,
          signInTokenHash: hashOpaqueToken(token),
          signInExpiresAt: expiresAt,
          issuedAt: now,
        },
        select: { id: true },
      });
      await this.audit.record(
        {
          action: "SUPPORT_SESSION_ISSUED",
          channel: "MANAGEMENT",
          targetKind: "supportSession",
          targetId: session.id,
          context: { access: access.id, supporter },
        },
        tx,
      );
      return {
        // In the fragment, so the browser never sends it to a server and it
        // appears in no access log and no Referer.
        signInUrl: `${applicationUrl(this.env.APP_URL)}/support#${token}`,
        expiresAt,
        accessEndsAt: access.endsAt,
      };
    });
  }

  /**
   * Uses a sign-in link: starts its session, and answers with the session's
   * token and when it ends.
   *
   * A link works once. The session is claimed by a write that only succeeds
   * while it has not started, so two uses of the same link racing each other
   * start it once and refuse the other.
   */
  async startSession(
    signInToken: string,
  ): Promise<{ token: string; supporter: string; expiresAt: Date }> {
    const token = randomBytes(32).toString("base64url");
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const session = await tx.supportSession.findUnique({
        where: { signInTokenHash: hashOpaqueToken(signInToken) },
        select: {
          id: true,
          supporter: true,
          startedAt: true,
          signInExpiresAt: true,
          access: true,
        },
      });
      if (
        session === null ||
        session.startedAt !== null ||
        session.signInExpiresAt <= now ||
        !(await isOpen(tx, session.access, now))
      ) {
        throw new SupportSignInInvalidError();
      }
      const expiresAt = new Date(
        Math.min(now.getTime() + SESSION_MS, session.access.endsAt.getTime()),
      );
      const claimed = await tx.supportSession.updateMany({
        where: { id: session.id, startedAt: null },
        data: {
          sessionTokenHash: hashOpaqueToken(token),
          startedAt: now,
          expiresAt,
        },
      });
      if (claimed.count !== 1) {
        throw new SupportSignInInvalidError();
      }
      await this.audit.record(
        {
          action: "SUPPORT_SESSION_STARTED",
          channel: "SUPPORT",
          supportSessionId: session.id,
          actorPersonId: session.access.openedById,
          targetKind: "supportSession",
          targetId: session.id,
        },
        tx,
      );
      return { token, supporter: session.supporter, expiresAt };
    });
  }

  /**
   * The session a support cookie's token belongs to, while it may still be
   * used, or null.
   *
   * Asked on every request the cookie comes with: the session has started and
   * not ended or expired, its access is open and not past its end, and the
   * ADMIN grant the access was opened under still exists.
   */
  async resolve(sessionToken: string): Promise<SupportSessionContext | null> {
    const now = new Date();
    const session = await this.prisma.supportSession.findUnique({
      where: { sessionTokenHash: hashOpaqueToken(sessionToken) },
      select: {
        id: true,
        supporter: true,
        startedAt: true,
        expiresAt: true,
        endedAt: true,
        access: true,
      },
    });
    if (
      session === null ||
      session.startedAt === null ||
      session.expiresAt === null ||
      session.expiresAt <= now ||
      session.endedAt !== null ||
      !(await isOpen(this.prisma, session.access, now))
    ) {
      return null;
    }
    return {
      sessionId: session.id,
      accessId: session.access.id,
      openedById: session.access.openedById,
      supporter: session.supporter,
      endsAt:
        session.expiresAt < session.access.endsAt
          ? session.expiresAt
          : session.access.endsAt,
    };
  }

  /**
   * Ends the session a support cookie's token belongs to, when it has not
   * ended already. Nothing happens for a token that names no session.
   */
  async endSession(sessionToken: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const session = await tx.supportSession.findUnique({
        where: { sessionTokenHash: hashOpaqueToken(sessionToken) },
        select: { id: true, access: { select: { openedById: true } } },
      });
      if (session === null) {
        return;
      }
      const ended = await tx.supportSession.updateMany({
        where: { id: session.id, endedAt: null },
        data: { endedAt: new Date() },
      });
      if (ended.count === 0) {
        return;
      }
      await this.audit.record(
        {
          action: "SUPPORT_SESSION_ENDED",
          channel: "SUPPORT",
          supportSessionId: session.id,
          actorPersonId: session.access.openedById,
          targetKind: "supportSession",
          targetId: session.id,
        },
        tx,
      );
    });
  }

  private async view(accessId: string): Promise<SupportAccessView> {
    const row = await this.prisma.supportAccess.findUniqueOrThrow({
      where: { id: accessId },
      include: ACCESS_WITH_SESSIONS,
    });
    const [view] = await this.views([row]);
    if (view === undefined) {
      throw new Error("A support access read back as nothing.");
    }
    return view;
  }

  private async views(
    rows: readonly AccessWithSessions[],
  ): Promise<SupportAccessView[]> {
    const grants = await this.prisma.systemRole.findMany({
      where: { id: { in: rows.map((row) => row.openedUnderGrantId) } },
      select: { id: true, personId: true, role: true },
    });
    const standing = new Set(
      grants
        .filter((grant) => grant.role === "ADMIN")
        .map((grant) => `${grant.id}:${grant.personId}`),
    );
    const personIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.closedById === null
            ? [row.openedById]
            : [row.openedById, row.closedById],
        ),
      ),
    ];
    const persons = await this.prisma.person.findMany({
      where: { id: { in: personIds } },
      select: { id: true, firstName: true, lastName: true },
    });
    const byId = new Map(persons.map((person) => [person.id, person]));
    const personView = (personId: string): SupportPersonView => {
      const person = byId.get(personId);
      return {
        personId,
        name:
          person === undefined
            ? null
            : `${person.firstName} ${person.lastName}`.trim(),
      };
    };
    const now = new Date();

    return rows.map((row) => ({
      id: row.id,
      state: stateOf(
        row,
        standing.has(`${row.openedUnderGrantId}:${row.openedById}`),
        now,
      ),
      openedAt: row.openedAt.toISOString(),
      openedBy: personView(row.openedById),
      endsAt: row.endsAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
      closedBy: row.closedById === null ? null : personView(row.closedById),
      sessions: row.sessions.map((session) => ({
        id: session.id,
        supporter: session.supporter,
        issuedAt: session.issuedAt.toISOString(),
        startedAt: session.startedAt?.toISOString() ?? null,
        expiresAt: session.expiresAt?.toISOString() ?? null,
        endedAt: session.endedAt?.toISOString() ?? null,
      })),
    }));
  }
}

/** What "open" is asked of. */
interface AccessRow {
  id: string;
  openedById: string;
  openedUnderGrantId: string;
  endsAt: Date;
  closedAt: Date | null;
}

function stateOf(
  access: AccessRow,
  grantStands: boolean,
  now: Date,
): SupportAccessState {
  if (access.closedAt !== null) {
    return "closed";
  }
  if (access.endsAt <= now) {
    return "ended";
  }
  return grantStands ? "open" : "lapsed";
}

/** Whether an access is open now. */
async function isOpen(
  db: PrismaService | Prisma.TransactionClient,
  access: AccessRow,
  now: Date,
): Promise<boolean> {
  return stateOf(access, await grantStands(db, access), now) === "open";
}

/** Whether the ADMIN grant an access was opened under still exists. */
async function grantStands(
  db: PrismaService | Prisma.TransactionClient,
  access: AccessRow,
): Promise<boolean> {
  const held = await db.systemRole.count({
    where: {
      id: access.openedUnderGrantId,
      personId: access.openedById,
      role: "ADMIN",
    },
  });
  return held > 0;
}

/**
 * The access that is open now, or null.
 *
 * Every access not closed and not past its end is a candidate, and the first
 * whose grant still stands is it. There is at most one such candidate, since
 * opening refuses while one is open and a grant that is gone does not come
 * back; one whose grant is gone has lapsed, and a new one may be opened beside
 * it.
 */
async function openAccess(
  tx: Prisma.TransactionClient,
  now: Date,
): Promise<AccessRow | null> {
  const candidates = await tx.supportAccess.findMany({
    where: { closedAt: null, endsAt: { gt: now } },
    orderBy: { openedAt: "desc" },
    select: {
      id: true,
      openedById: true,
      openedUnderGrantId: true,
      endsAt: true,
      closedAt: true,
    },
  });
  for (const candidate of candidates) {
    if (await grantStands(tx, candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * The lock opening, closing and issuing take, so each reads what the one before
 * it wrote. An advisory lock for the reason `retention-lock.ts` gives, taken
 * for the transaction.
 */
async function lockSupportAccess(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"support-access"}))`;
}
