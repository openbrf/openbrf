import { Injectable, Logger } from "@nestjs/common";
import type { ActionErrorSpec, ActionEffect } from "@openbrf/plugin-sdk";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";
import { ZodError } from "zod";

import {
  type ActionCaller,
  ActionCallerFactory,
  type RequestWithToken,
} from "../actions/action-caller";
import {
  ActionInputNames,
  type InputName,
} from "../actions/action-input-names";
import { ActionRegistryService } from "../actions/action-registry.service";
import { dispatchFailure, isRefusal } from "../actions/action.error";
import { actionChannelOf, actorOf } from "../actions/actor-of";
import type { ActionTargetView } from "../actions/core-action";
import {
  type ActorContext,
  auditActor,
  webActor,
} from "../audit/actor-context";
import { AuditLogService } from "../audit/audit-log.service";
import type { Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import { failureFrames, failureName } from "../logging/failure";
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

/** The person reading their pending changes: the request's principal. */
type Reader = Pick<Principal, "personId" | "capabilities">;

/**
 * How many waiting changes the list resolves the target of at a time.
 *
 * Each target costs a principal read and a read of the record it names, and
 * the connection pool is shared with every other request: a person with a long
 * queue must not hold all of it while their list is built.
 */
const VIEW_BATCH_SIZE = 10;

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
  /**
   * What the change is to, read as the view is: the item or page its input
   * names by id, as it stands now and as confirming would leave it. Null for
   * an action that names no such thing.
   *
   * An id in the input says nothing a person can check, so without this the
   * person confirming "publish" could not tell which item it publishes. Read
   * afresh each time rather than stored, since the target may have changed or
   * gone since the proposal; it is shown only to somebody who still holds the
   * action's capability (`ActionRegistryService.targetOf`).
   */
  readonly target: ActionTargetView | null;
  /**
   * What the ids in the input stand for, by id, where the action's feature
   * names them and the reader holds what reads them now. The input is shown
   * as it is sent and an id with no name stays as it is, so this only adds to
   * the preview.
   */
  readonly names: Record<string, InputName>;
  /** Which way it was proposed: a plugin's route, or later the AI package. */
  readonly channel: AuditChannel;
  /** The connected app that proposed it, when one did. */
  readonly clientHost: string | null;
  readonly proposedAt: Date;
  readonly expiresAt: Date;
}

/**
 * The pending-change queue (ADR 0039).
 *
 * A pending change is one call to an action, held as a preview until the person
 * who proposed it confirms or rejects it on the platform's own screen. Nothing
 * runs when it is proposed. Confirming dispatches the held call through
 * `ActionRegistryService.invokeHeld()` as the confirming person, on the `web`
 * channel, with every check the registry makes on any call made again at that
 * moment - so a board term that ended in between, an action disarmed in
 * between or a page edited in between refuses it then, and the registry stays
 * the one place a change is dispatched.
 *
 * A row exists only while the change waits, or - unseen - after a
 * confirmation that could not record itself (`confirm`). Confirming and
 * rejecting delete it in the transaction that records the act, and the
 * nightly sweep deletes one whose week has run out
 * (`pending-change-sweep.ts`). What stays is the audit log: who proposed which action through which channel and app, and who
 * confirmed or rejected it - never the input, which can name a resident and is
 * the proposer's until they act on it.
 *
 * ## Who may act on one
 *
 * Its proposer, and nobody else. Each query below is keyed on the person as
 * well as the id, and a change somebody else proposed answers exactly as one
 * that does not exist. A pending change is the proposer's own: it may hold what
 * only they asked for, and it may be for an action that is about themselves.
 */
@Injectable()
export class PendingChangeService {
  private readonly logger = new Logger(PendingChangeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly registry: ActionRegistryService,
    private readonly callers: ActionCallerFactory,
    private readonly inputNames: ActionInputNames,
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
   *
   * An action that does not declare `personalIdentityNumber` is not one that
   * takes a personal identity number, so a text carrying one is refused here.
   * The core services refuse one in free text when they write, so for a core
   * action the queue holds nothing the action could not write. A plugin's
   * handler need not refuse one: for a plugin action the declaration is the
   * rule, and the queue refuses what the action might have written.
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
    if (!definition.personalData.includes("personalIdentityNumber")) {
      refusePersonalIdentityNumbers(value);
    }
    const expiresAt = new Date(now.getTime() + PENDING_CHANGE_LIFETIME_MS);
    const actor = actorOf({
      principal: { personId: resolved.personId, capabilities: [] },
      channel: resolved.channel,
      ...(resolved.client === null ? {} : { client: resolved.client }),
      ...(resolved.pluginId === null ? {} : { pluginId: resolved.pluginId }),
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

  /**
   * The changes waiting for this person, oldest first.
   *
   * The reader is the request's principal, with the capabilities they hold
   * now: they decide which ids in an input are named (`ActionInputNames`).
   */
  async mine(
    reader: Reader,
    locale: string | null | undefined,
    now: Date = new Date(),
  ): Promise<PendingChangeView[]> {
    const rows = await this.prisma.pendingChange.findMany({
      where: waitingFor(reader.personId, now),
      orderBy: { proposedAt: "asc" },
    });
    // In batches, so the work one request starts is bounded. Each change still
    // reads its own principal: one shared across entries would not follow the
    // live authorization the target check is there for.
    const views: PendingChangeView[] = [];
    for (let from = 0; from < rows.length; from += VIEW_BATCH_SIZE) {
      views.push(
        ...(await Promise.all(
          rows
            .slice(from, from + VIEW_BATCH_SIZE)
            .map((row) => this.view(row, reader, locale)),
        )),
      );
    }
    return views;
  }

  /** One change waiting for this person, read as `mine` reads it. */
  async one(
    reader: Reader,
    id: string,
    locale: string | null | undefined,
    now: Date = new Date(),
  ): Promise<PendingChangeView> {
    const row = await this.prisma.pendingChange.findFirst({
      where: { id, ...waitingFor(reader.personId, now) },
    });
    if (row === null) {
      throw notFound();
    }
    return this.view(row, reader, locale);
  }

  /**
   * Runs a held call as the person confirming it, and ends the pending change.
   *
   * The action's service writes in a transaction of its own, which no
   * transaction here can enlist, so the change is not consumed with the write
   * but claimed before it. `invokeHeld` makes every check, then calls the
   * claim below, then the handler. The claim stamps `dispatchedAt` on a row
   * that is still waiting, in a write that commits at once, and from then on
   * the change is not waiting: a second press, a retry, a reject and the
   * screen all find nothing. So the action runs at most once for a change,
   * whatever fails after it.
   *
   * What happens next depends on what the action answered:
   *
   * - A refusal at a check - the person no longer holds its capability, the
   *   action was disarmed - comes before the claim, and the change keeps
   *   waiting untouched, to be rejected.
   * - A refusal from the action's own service - the page moved on, the
   *   address is taken - wrote nothing, so the claim is lifted and the change
   *   waits again. The action's own refusal travels to the screen.
   * - Anything else ends the change, whether the action succeeded or failed:
   *   a failure from the handler may have come after its write committed, and
   *   an output its schema refuses certainly did. So does a refusal that hands
   *   on such a failure, from an action the held one invoked in turn
   *   (`dispatchFailure`). A failure here answers
   *   `pending-change-failed-after-dispatch` rather than the action's own
   *   reason, so the screen says the change may have been carried out and is
   *   no longer waiting, instead of offering it again.
   *
   * The action's service writes its own audit entry, as the confirming person
   * on `web`, and it names this pending change (`auditActor`). The entry
   * written here says that it was confirmed, and for a confirmation whose
   * action failed, how. If even that cannot be written, the row stays as the
   * claim left it - not waiting, never to run again - and the nightly sweep
   * ends it, saying it was dispatched.
   *
   * `clock` is read twice: when the change is looked up, and again at the
   * claim, which holds the change to its expiry at that moment. The registry's
   * checks in between are asynchronous, and a change that lapsed while they
   * ran is past its expiry and does not run (ADR 0039, §6).
   */
  async confirm(
    request: RequestWithToken,
    id: string,
    clock: () => Date = () => new Date(),
  ): Promise<void> {
    const actor = webActor(request);

    const held = await this.prisma.pendingChange.findFirst({
      where: { id, ...waitingFor(actor.personId, clock()) },
      select: { actionName: true, input: true, channel: true },
    });
    const proposedOn = held === null ? null : actionChannelOf(held.channel);
    if (held === null || proposedOn === null) {
      throw notFound();
    }

    // Held in an object because the claim sets it from inside the registry's
    // call, where the compiler cannot follow an assignment to a local.
    const claimed: { at: Date | null } = { at: null };
    const claim = async (): Promise<void> => {
      const at = clock();
      const { count } = await this.prisma.pendingChange.updateMany({
        where: { id, ...waitingFor(actor.personId, at) },
        data: { dispatchedAt: at },
      });
      if (count === 0) {
        // Another press claimed it between the read above and here, or it
        // reached its expiry while the registry checked it.
        throw notFound();
      }
      claimed.at = at;
    };

    try {
      await this.registry.invokeHeld(
        this.callers.forConfirmation(request, { id, proposedOn }),
        held.actionName,
        held.input,
        claim,
      );
    } catch (cause) {
      if (claimed.at === null) {
        throw cause;
      }
      if (isRefusal(cause)) {
        await this.release(id, claimed.at);
        throw cause;
      }
      // A failure from recording it is logged, and leaves the row for the
      // sweep: either way the change is no longer waiting.
      await this.end(id, actor, held.actionName, failureOf(cause)).catch(
        (recording: unknown) => {
          this.logger.error(
            `Pending change ${id} was dispatched and its failure could not be recorded: ${failureName(recording)}`,
            failureFrames(recording),
          );
        },
      );
      throw failedAfterDispatch(cause);
    }
    try {
      await this.end(id, actor, held.actionName, null);
    } catch (cause) {
      // The action ran and the row stays claimed for the sweep, so this
      // confirmation answers as one that failed after it was dispatched.
      this.logger.error(
        `Pending change ${id} ran and its confirmation could not be recorded: ${failureName(cause)}`,
        failureFrames(cause),
      );
      throw failedAfterDispatch(cause);
    }
  }

  /** Ends a pending change without running it. */
  async reject(
    request: RequestWithToken,
    id: string,
    now: Date = new Date(),
  ): Promise<void> {
    const actor = webActor(request);

    await this.prisma.$transaction(async (tx) => {
      // Locked, and only while still waiting: a change a confirmation in
      // another tab has claimed is not rejected after its action ran.
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

  /**
   * Lets a claimed change wait again, after its action refused.
   *
   * Only the claim this confirmation made: matched on its own stamp, so a row
   * the person's purge deleted in between stays deleted. If this write fails,
   * the change stays claimed and is lost to the person, which is the side to
   * fail on: it can be proposed again, and it cannot run twice.
   */
  private async release(id: string, dispatchedAt: Date): Promise<void> {
    try {
      await this.prisma.pendingChange.updateMany({
        where: { id, dispatchedAt },
        data: { dispatchedAt: null },
      });
    } catch (cause) {
      this.logger.error(
        `Pending change ${id} stays claimed: its refused action could not be released: ${failureName(cause)}`,
        failureFrames(cause),
      );
    }
  }

  /** Ends a change whose action was dispatched, and records that it was. */
  private async end(
    id: string,
    actor: ActorContext,
    actionName: string,
    failure: string | null,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.pendingChange.deleteMany({ where: { id } });
      await this.audit.record(
        {
          action: "PENDING_CHANGE_CONFIRMED",
          ...auditActor(actor),
          targetKind: "pendingChange",
          targetId: id,
          // The reason the action failed with, a code, when it did: the write
          // may stand, and its own entry says so if it does.
          context:
            failure === null
              ? { action: actionName }
              : { action: actionName, failure },
        },
        tx,
      );
    });
  }

  private async view(
    row: {
      id: string;
      actionName: string;
      input: unknown;
      channel: AuditChannel;
      clientHost: string | null;
      proposedAt: Date;
      expiresAt: Date;
    },
    reader: Reader,
    locale: string | null | undefined,
  ): Promise<PendingChangeView> {
    const summary = this.registry.summaryOf(row.actionName, locale);
    const target = await this.registry.targetOf(
      row.actionName,
      row.input,
      reader.personId,
    );
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
      target,
      names: await this.inputNames.namesOf(row.actionName, row.input, reader),
      channel: row.channel,
      clientHost: row.clientHost,
      proposedAt: row.proposedAt,
      expiresAt: row.expiresAt,
    };
  }
}

/**
 * The changes still waiting for this person: theirs, not past their expiry,
 * and not handed to their action by a confirmation.
 */
function waitingFor(
  personId: string,
  now: Date,
): Prisma.PendingChangeWhereInput {
  return {
    proposedByPersonId: personId,
    expiresAt: { gt: now },
    dispatchedAt: null,
  };
}

/**
 * Locks one change that is still waiting for this person, and reads what it
 * holds. Null for one that is not: absent, somebody else's, expired or
 * claimed by a confirmation.
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
      AND "dispatchedAt" IS NULL
    FOR UPDATE`;
  return locked[0] ?? null;
}

/**
 * The reason a dispatched action failed with, as the confirmation records it.
 * Past the claim the registry raises nothing but a refusal or one of its own
 * two failures, which a plugin's action may hand on wrapped.
 */
function failureOf(cause: unknown): string {
  return dispatchFailure(cause) ?? "internal";
}

function notFound(): PendingChangeError {
  return new PendingChangeError(
    "No such pending change is waiting for you.",
    "pending-change-not-found",
  );
}

function failedAfterDispatch(cause: unknown): PendingChangeError {
  return new PendingChangeError(
    "The pending change was dispatched and did not finish; its action may have written.",
    "pending-change-failed-after-dispatch",
    { cause },
  );
}

/**
 * Refuses an input whose text carries a Swedish personal identity number.
 *
 * Answered as the registry answers an input its schema refuses: a 400 naming
 * the paths and never the value, which is the disclosure the rule exists to
 * stop.
 */
function refusePersonalIdentityNumbers(input: unknown): void {
  const paths: (string | number)[][] = [];
  const walk = (value: unknown, path: (string | number)[]): void => {
    if (typeof value === "string") {
      if (scanForPersonalIdentityNumbers(value).length > 0) paths.push(path);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        walk(item, [...path, index]);
      });
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value))
        walk(item, [...path, key]);
    }
  };
  walk(input, []);
  if (paths.length > 0) {
    throw new ZodError(
      paths.map((path) => ({
        code: "custom",
        path,
        message: "Contains a personal identity number.",
      })),
    );
  }
}
