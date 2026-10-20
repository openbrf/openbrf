import { Injectable } from "@nestjs/common";
import type { ActionErrorSpec, ActionEffect } from "@openbrf/plugin-sdk";

import {
  type ActionCaller,
  ActionCallerFactory,
  type RequestWithToken,
} from "../actions/action-caller";
import { ActionRegistryService } from "../actions/action-registry.service";
import { actorOf } from "../actions/actor-of";
import { auditActor, webActor } from "../audit/actor-context";
import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type { AuditChannel } from "../generated/prisma/enums";
import { PendingChangeError } from "./pending-change.error";

/**
 * How long a pending change waits for its proposer.
 *
 * A week: long enough for a board member who asked for a change on a Monday
 * evening to come back to it at the next board meeting, and short enough that
 * what the proposal was made against has seldom moved under it. Where it has,
 * the held action's own precondition refuses it when it is confirmed - a page's
 * revision, carried in the input - so the week bounds how long the input is
 * held rather than how stale a confirmed change may be.
 */
export const PENDING_CHANGE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a confirmation may take, the held action included.
 *
 * The row is locked for the whole confirmation so a second press waits for the
 * first instead of running the action twice, and the lock lives as long as the
 * transaction that took it. Prisma's default of five seconds suits a lookup;
 * an action may write a page with its media, so the budget is wider.
 */
const CONFIRM_TIMEOUT_MS = 60_000;

/** What proposing answers with: enough to send the person to the preview. */
export interface ProposedChange {
  readonly id: string;
  readonly expiresAt: Date;
}

/** One pending change, as the person who proposed it reads it. */
export interface PendingChangeView {
  readonly id: string;
  /**
   * The held action, in the reader's language. Null when nothing answers to
   * the name any more - its plugin was removed - and the change can then only
   * be rejected: confirming it would be refused as an unknown action.
   */
  readonly action: {
    readonly title: string;
    readonly description: string;
    readonly effect: ActionEffect;
    readonly needsConfirmation: boolean;
    /** The sentences the screen shows for a refusal the action can raise. */
    readonly errors: readonly ActionErrorSpec[];
  } | null;
  /** The action's public name, which is what the proposal holds. */
  readonly actionName: string;
  /** The input as the action's schema parsed it when it was proposed. */
  readonly input: unknown;
  /** Which way it was proposed: a plugin's route, or later the AI package. */
  readonly channel: AuditChannel;
  /** The connected app that proposed it, when one did. */
  readonly clientHost: string | null;
  readonly proposedAt: Date;
  readonly expiresAt: Date;
}

/**
 * The pending-change queue (väntande ändringar, ADR 0039).
 *
 * A pending change is one call to an action, held as a preview until the person
 * who proposed it confirms or rejects it on the platform's own screen. Nothing
 * runs when it is proposed. Confirming dispatches the held call through
 * `ActionRegistryService.invoke()` as the confirming person, on the `web`
 * channel, with every check the registry makes on any call made again at that
 * moment - so a board term that ended in between, an action disarmed in
 * between or a page edited in between refuses it then, and the registry stays
 * the one place a change is dispatched.
 *
 * A row exists only while the change waits. Confirming and rejecting delete
 * it in the transaction that records the act, and the nightly sweep deletes
 * one whose week has run out (`pending-change-sweep.ts`). What stays is the
 * audit log: who proposed which action through which channel and app, and who
 * confirmed or rejected it - never the input, which can name a resident and is
 * the proposer's until they act on it.
 *
 * ## Who may act on one
 *
 * Its proposer, and nobody else. Each query below is keyed on the person as
 * well as the id, and a change somebody else proposed answers exactly as one
 * that does not exist. A proposal is the proposer's draft: it may hold what
 * only they asked for, and it may be for an action that is about themselves.
 */
@Injectable()
export class PendingChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly registry: ActionRegistryService,
    private readonly callers: ActionCallerFactory,
  ) {}

  /**
   * Holds a call as a pending change, without running it.
   *
   * The call is held to everything `invoke()` would hold it to before the
   * handler, as the proposer and on the channel they came by: the action
   * exists and is offered there, its plugin is serving and armed, the
   * proposer holds its capability now, and the input is one its schema takes.
   * What the schema refuses is refused here, rather than first when the person
   * presses confirm.
   */
  async propose(
    caller: ActionCaller,
    nameOrAlias: string,
    input: unknown,
    now: Date = new Date(),
  ): Promise<ProposedChange> {
    const resolved = this.callers.resolve(caller);
    const { definition, value } = await this.registry.check(
      caller,
      nameOrAlias,
      input,
    );
    const expiresAt = new Date(now.getTime() + PENDING_CHANGE_LIFETIME_MS);
    const actor = actorOf({
      principal: { personId: resolved.personId, capabilities: [] },
      channel: resolved.channel,
      ...(resolved.client === null ? {} : { client: resolved.client }),
      requestId: resolved.requestId,
      now,
    });

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.pendingChange.create({
        data: {
          // The canonical name, so an alias the proposal arrived under cannot
          // outlive the action it pointed at under a different meaning.
          actionName: definition.name,
          // Cast at the persistence boundary: the parsed input is JSON by
          // construction, since registration refuses a schema that cannot be
          // published as JSON Schema.
          input: value as Prisma.InputJsonValue,
          proposedByPersonId: resolved.personId,
          channel: actor.channel,
          clientId: actor.clientId ?? null,
          clientHost: actor.clientHost ?? null,
          proposedAt: now,
          expiresAt,
        },
        select: { id: true, expiresAt: true },
      });
      await this.audit.record(
        {
          action: "PENDING_CHANGE_PROPOSED",
          ...auditActor(actor),
          targetKind: "pendingChange",
          targetId: row.id,
          // The action's name and never its input: the input can name a
          // resident, and this table outlives the proposal by design.
          context: { action: definition.name },
        },
        tx,
      );
      return row;
    });
  }

  /** The changes waiting for this person, oldest first. */
  async mine(
    personId: string,
    locale: string | null | undefined,
    now: Date = new Date(),
  ): Promise<PendingChangeView[]> {
    const rows = await this.prisma.pendingChange.findMany({
      where: { proposedByPersonId: personId, expiresAt: { gt: now } },
      orderBy: { proposedAt: "asc" },
    });
    return rows.map((row) => this.view(row, locale));
  }

  /** One change waiting for this person. */
  async one(
    personId: string,
    id: string,
    locale: string | null | undefined,
    now: Date = new Date(),
  ): Promise<PendingChangeView> {
    const row = await this.prisma.pendingChange.findFirst({
      where: { id, proposedByPersonId: personId, expiresAt: { gt: now } },
    });
    if (row === null) {
      throw notFound();
    }
    return this.view(row, locale);
  }

  /**
   * Runs a held call as the person confirming it, and ends the pending change.
   *
   * The row is locked first, so a second press on the same change waits for
   * the first and then finds nothing. If the held action refuses - the person
   * no longer holds its capability, the page moved on, the input no longer
   * fits - the transaction rolls back, the change keeps waiting, and the
   * action's own refusal travels to the screen, where the person can reject
   * it instead.
   *
   * The action's service writes its own audit entry, as the confirming person
   * on `web`, and it names this pending change (`auditActor`). The entry
   * written here says that it was confirmed.
   */
  async confirm(
    request: RequestWithToken,
    id: string,
    now: Date = new Date(),
  ): Promise<void> {
    const actor = webActor(request);

    await this.prisma.$transaction(
      async (tx) => {
        const held = await lockWaiting(tx, id, actor.personId, now);
        if (held === null) {
          throw notFound();
        }

        await this.registry.invoke(
          this.callers.forConfirmation(request, id),
          held.actionName,
          held.input,
        );

        await tx.pendingChange.delete({ where: { id } });
        await this.audit.record(
          {
            action: "PENDING_CHANGE_CONFIRMED",
            ...auditActor(actor),
            targetKind: "pendingChange",
            targetId: id,
            context: { action: held.actionName },
          },
          tx,
        );
      },
      { timeout: CONFIRM_TIMEOUT_MS },
    );
  }

  /** Ends a pending change without running it. */
  async reject(
    request: RequestWithToken,
    id: string,
    now: Date = new Date(),
  ): Promise<void> {
    const actor = webActor(request);

    await this.prisma.$transaction(async (tx) => {
      // Locked as confirm locks it, so a reject cannot slip in while the same
      // change is being confirmed in another tab and record an act that lost.
      const held = await lockWaiting(tx, id, actor.personId, now);
      if (held === null) {
        throw notFound();
      }
      await tx.pendingChange.delete({ where: { id } });
      await this.audit.record(
        {
          action: "PENDING_CHANGE_REJECTED",
          ...auditActor(actor),
          targetKind: "pendingChange",
          targetId: id,
          context: { action: held.actionName },
        },
        tx,
      );
    });
  }

  private view(
    row: {
      id: string;
      actionName: string;
      input: unknown;
      channel: AuditChannel;
      clientHost: string | null;
      proposedAt: Date;
      expiresAt: Date;
    },
    locale: string | null | undefined,
  ): PendingChangeView {
    const summary = this.registry.summaryOf(row.actionName, locale);
    return {
      id: row.id,
      action:
        summary === null
          ? null
          : {
              title: summary.title,
              description: summary.description,
              effect: summary.effect,
              needsConfirmation: summary.needsConfirmation,
              errors: summary.errors,
            },
      actionName: row.actionName,
      input: row.input,
      channel: row.channel,
      clientHost: row.clientHost,
      proposedAt: row.proposedAt,
      expiresAt: row.expiresAt,
    };
  }
}

/**
 * Locks one change that is still waiting for this person, and reads what it
 * holds. Null for one that is not: absent, somebody else's, or expired.
 *
 * A second transaction asking for the same row waits here until the first has
 * committed, and then finds it gone.
 */
async function lockWaiting(
  tx: Prisma.TransactionClient,
  id: string,
  personId: string,
  now: Date,
): Promise<{ actionName: string; input: unknown } | null> {
  const locked = await tx.$queryRaw<{ actionName: string; input: unknown }[]>`
    SELECT "actionName", "input" FROM pending_change
    WHERE id = ${id}
      AND "proposedByPersonId" = ${personId}
      AND "expiresAt" > ${now}
    FOR UPDATE`;
  return locked[0] ?? null;
}

function notFound(): PendingChangeError {
  return new PendingChangeError(
    "No such pending change is waiting for you.",
    "pending-change-not-found",
  );
}
