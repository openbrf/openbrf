import { HttpStatus, Injectable } from "@nestjs/common";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import { type ActorContext, auditActor } from "../audit/actor-context";
import { AuditLogService } from "../audit/audit-log.service";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { DomainError } from "../http/domain-error";

/**
 * The association's own facts, as the board records them and as the broker
 * page renders them.
 *
 * Everything here is written by a board member and read by anyone with the
 * address of the page. There is no register in this file and there is no route
 * to one: the whole point of the broker page is that a housing cooperative
 * answers a broker out of what its board has said about the building, rather
 * than out of the member register - which holds personal data about named
 * people and belongs to nobody but the association and the authorities.
 *
 * A fact nobody has recorded is null and stays null. The page omits it; there
 * is no placeholder, no "not recorded" and no empty label, because the page is
 * read by somebody who has no way to fill it in and telling them a question
 * exists without answering it is worse than not raising it.
 *
 * The page also says when the board last stood behind its answers. A save does
 * that, and so does a confirmation that changes nothing: a board that reads its
 * facts in March and finds them still true has to be able to say so without
 * retyping a sentence, or the date a broker reads would only ever say when
 * somebody last edited a field.
 *
 * How long the answers count as current after that is the board's own setting,
 * in whole months. It is stored beside the date and changed on its own, and a
 * change to it confirms nothing: it is not a fact, and a board that shortens
 * its threshold has said nothing about whether the fee policy still holds.
 */

/** The free-text facts, in the order the board's screen asks for them. */
export const FACT_TEXT_FIELDS = [
  "propertyDesignation",
  "siteLeaseholdNote",
  "feePolicy",
  "feeIncludes",
  "transferFeePolicy",
  "pledgeFeePolicy",
  "legalPersonOwnersNote",
  "parking",
  "storage",
  "renovations",
] as const;

export type FactTextField = (typeof FACT_TEXT_FIELDS)[number];

/** The facts that are a yes or a no rather than a sentence. */
export const FACT_FLAG_FIELDS = ["siteLeasehold", "legalPersonOwners"] as const;

export type FactFlagField = (typeof FACT_FLAG_FIELDS)[number];

/**
 * How many months the facts count as current, at least and at most.
 *
 * A month is the shortest span over which a board can be expected to look at
 * its facts again, and a year the longest a broker should be told that answers
 * nobody has looked at are current: an annual meeting falls inside it, and the
 * fee is usually reviewed there.
 */
export const STALE_AFTER_MONTHS_MIN = 1;
export const STALE_AFTER_MONTHS_MAX = 12;

/** What an association that has not set the threshold gets. */
export const STALE_AFTER_MONTHS_DEFAULT = 3;

export type AssociationFactsView = Record<FactTextField, string | null> &
  Record<FactFlagField, boolean | null> & {
    buildYear: number | null;
    /**
     * When a fact was last written, as an ISO instant, or null while the board
     * has recorded nothing at all.
     */
    updatedAt: string | null;
    /**
     * When a board member last stated that the facts hold, by saving them or by
     * confirming them unchanged. ISO instant, null while nothing is recorded.
     */
    confirmedAt: string | null;
    /** How many whole months the facts count as current after confirmedAt. */
    staleAfterMonths: number;
  };

export type AssociationFactsInput = Partial<
  Record<FactTextField, string | null>
> &
  Partial<Record<FactFlagField, boolean | null>> & {
    buildYear?: number | null;
  };

/** Where in the facts a refused value sits. */
export interface FactTextLocation {
  /** The field's name, exactly as the board's screen labels it. */
  field: FactTextField;
  /** Where in that text the value starts. */
  offset: number;
}

export type AssociationFactsReason = "personal-identity-number";

export class AssociationFactsError extends DomainError {
  readonly status = HttpStatus.UNPROCESSABLE_ENTITY;

  constructor(
    message: string,
    readonly reason: AssociationFactsReason,
    private readonly locations: readonly FactTextLocation[],
  ) {
    super(message);
  }

  override details(): Record<string, readonly unknown[]> {
    return { locations: this.locations };
  }
}

/**
 * The board confirmed facts it has never recorded.
 *
 * A refusal of its own rather than a reason on AssociationFactsError, because
 * no action can raise it: confirming is the board's attestation and is done on
 * its screen, while the actions over these facts read and save them. Putting
 * it in that union would publish it as a refusal the save can return.
 */
export class AssociationFactsUnrecordedError extends DomainError {
  readonly status = HttpStatus.CONFLICT;
  readonly reason = "nothing-recorded";
}

/**
 * A threshold outside the range the board may set.
 *
 * The controller refuses one before it gets here; this is the service holding
 * its own rule for a caller that is not the controller.
 */
export class StaleAfterMonthsError extends DomainError {
  readonly status = HttpStatus.UNPROCESSABLE_ENTITY;
  readonly reason = "stale-after-months-out-of-range";
}

/**
 * What a confirmation hands to whoever is told about it.
 *
 * A save and a confirmation both produce one: either is the board standing
 * behind the facts as they now are.
 */
export interface FactsConfirmedEvent {
  /** The new confirmedAt. */
  confirmedAt: Date;
  actor: ActorContext;
}

/**
 * Work another feature does when the board confirms the facts, in the same
 * transaction as the confirmation.
 *
 * A hook that throws rolls the confirmation back with it. That is the point of
 * running inside the transaction: a broker's open request for an update is
 * answered by the confirmation, and a page that said "confirmed today" over a
 * request still marked open would be two records disagreeing about one act.
 */
export type FactsConfirmedHook = (
  tx: Prisma.TransactionClient,
  event: FactsConfirmedEvent,
) => Promise<void>;

/** The single row. One association per instance, so one row of facts. */
const ROW_ID = 1;

/** How much one fact may hold. A bound against abuse, not design guidance. */
const MAX_TEXT = 4000;

const UNRECORDED: AssociationFactsView = {
  propertyDesignation: null,
  buildYear: null,
  siteLeasehold: null,
  siteLeaseholdNote: null,
  feePolicy: null,
  feeIncludes: null,
  transferFeePolicy: null,
  pledgeFeePolicy: null,
  legalPersonOwners: null,
  legalPersonOwnersNote: null,
  parking: null,
  storage: null,
  renovations: null,
  updatedAt: null,
  confirmedAt: null,
  staleAfterMonths: STALE_AFTER_MONTHS_DEFAULT,
};

@Injectable()
export class AssociationFactsService {
  private readonly confirmedHooks: FactsConfirmedHook[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Runs `hook` inside every save and every confirmation, after the facts are
   * written and before the transaction commits.
   *
   * For a feature whose own records a confirmation settles, registered from
   * that feature's module init. Not for telling anybody: a hook that mailed a
   * broker would mail them about a confirmation that could still roll back.
   */
  onConfirmed(hook: FactsConfirmedHook): void {
    this.confirmedHooks.push(hook);
  }

  /**
   * What the board has recorded, whether or not it has recorded anything.
   *
   * An instance that has never opened the screen has no row, and that answers
   * with every fact null rather than with nothing at all. The board's screen
   * then renders an empty form instead of a failure, and the public page
   * renders the association's name and organisation number and no facts - which
   * is the state the feature ships in.
   */
  async read(): Promise<AssociationFactsView> {
    const row = await this.prisma.associationFacts.findUnique({
      where: { id: ROW_ID },
    });
    return row === null ? UNRECORDED : toView(row);
  }

  /**
   * Records the facts.
   *
   * Every field the request carries is written, including a field cleared back
   * to nothing: a board that deletes a fee policy because it no longer holds
   * has to be able to take it off the page, and an omitted field and an emptied
   * one are told apart by the field being absent from the body rather than by
   * its value.
   *
   * The personal identity number scan runs first, over the whole submission.
   * Every fact here is board-typed free text on a page that is public from the
   * moment it is written - there is no draft state for a fact and no separate
   * act of publishing one - so the rule the page editor applies at publication
   * time applies to every save here. It is the same scanner
   * (scanForPersonalIdentityNumbers, the one PagesWriteService runs): a second
   * detector would be a second thing to keep correct, and the two would
   * disagree the first time either was improved.
   *
   * The entry is written in the same transaction as the upsert. These facts are
   * published on the broker information page the moment they are saved - there
   * is no draft state for a fact - so a fact changed here is a change to what
   * the association tells a buyer, and ADR 0008 makes attribution the thing
   * that licenses a direct write. It carries which fields the save named and
   * never their text: the log is append-only and exempt from every purge, so a
   * fee policy copied into it would outlive the one on the page.
   *
   * A save that changes nothing still records. The field list is what the
   * caller submitted rather than a diff, because a diff would need the row read
   * before the write and would then be a second statement about a second
   * moment; and an act that turns out to have written the same value is still
   * an act somebody took.
   *
   * Every save also moves the date the page gives as the facts' last
   * confirmation, and the entry above is that move's record. The board member
   * who saved stood behind the facts as they left them, edited or not, which is
   * all a confirmation says.
   */
  async save(
    input: AssociationFactsInput,
    actor: ActorContext,
  ): Promise<AssociationFactsView> {
    const data = normalize(input);
    refusePersonalIdentityNumbers(data);

    const confirmedAt = new Date();

    const row = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.associationFacts.upsert({
        where: { id: ROW_ID },
        create: { id: ROW_ID, ...data, confirmedAt },
        update: { ...data, confirmedAt },
      });

      await this.audit.record(
        {
          action: "ASSOCIATION_FACTS_RECORDED",
          ...auditActor(actor),
          // No subject. The facts name nobody: thirteen fields about the
          // building, the fees and the land, and a person in one of them is
          // what the identity number scan above exists to refuse.
          targetKind: "associationFacts",
          targetId: String(ROW_ID),
          context: { fields: Object.keys(data).sort() },
        },
        tx,
      );

      await this.runConfirmedHooks(tx, { confirmedAt, actor });

      return saved;
    });

    return toView(row);
  }

  /**
   * Records that the facts still hold, as they stand, and changes none of them.
   *
   * What the board does when a broker's question, or the calendar, sends it
   * back to the page and it finds nothing to correct. The date the page prints
   * moves to now; updatedAt does not, because no fact was written, and it is
   * passed back unchanged so Prisma does not move it on its own.
   *
   * Refused while nothing has been recorded: no row, or a row only the
   * threshold created and nobody has saved. There is nothing to stand behind,
   * and a page that said "confirmed today" over no facts at all would be telling
   * a broker the board had answered questions it has not.
   *
   * Recorded in the same transaction, as a save is. The entry carries the date
   * it replaced, so the log answers how stale the page had been when the board
   * looked at it - the question a broker's request for an update turns on.
   */
  async confirm(actor: ActorContext): Promise<AssociationFactsView> {
    const row = await this.prisma.$transaction(async (tx) => {
      const stored = await tx.associationFacts.findUnique({
        where: { id: ROW_ID },
        select: { updatedAt: true, confirmedAt: true },
      });
      if (stored === null || stored.confirmedAt === null) {
        throw new AssociationFactsUnrecordedError(
          "The association has recorded no facts to confirm.",
        );
      }

      const confirmedAt = new Date();
      const confirmed = await tx.associationFacts.update({
        where: { id: ROW_ID },
        data: { confirmedAt, updatedAt: stored.updatedAt },
      });

      await this.audit.record(
        {
          action: "ASSOCIATION_FACTS_CONFIRMED",
          ...auditActor(actor),
          targetKind: "associationFacts",
          targetId: String(ROW_ID),
          context: { previousConfirmedAt: stored.confirmedAt.toISOString() },
        },
        tx,
      );

      await this.runConfirmedHooks(tx, { confirmedAt, actor });

      return confirmed;
    });

    return toView(row);
  }

  /**
   * Sets how many months the facts count as current after their last
   * confirmation.
   *
   * Moves neither confirmedAt nor updatedAt, and runs no confirmation hook. The
   * threshold is not a fact, so changing it writes none and confirms none: a
   * board that shortens it from six months to three has said nothing about the
   * fee policy, and a broker who reads "confirmed today" afterwards would be
   * told it had. updatedAt is passed back unchanged so Prisma does not move it
   * on its own.
   *
   * Allowed before any fact is recorded. The row is created then, with no
   * answer in it and no confirmation date, and reads as unrecorded until the
   * first save.
   *
   * Recorded in the same transaction, with the number it replaced and the one
   * it set. A change to the same number is recorded too, as a save that changes
   * nothing is: it is still an act somebody took.
   */
  async setStaleAfterMonths(
    months: number,
    actor: ActorContext,
  ): Promise<AssociationFactsView> {
    if (
      !Number.isInteger(months) ||
      months < STALE_AFTER_MONTHS_MIN ||
      months > STALE_AFTER_MONTHS_MAX
    ) {
      throw new StaleAfterMonthsError(
        `The facts count as current for ${STALE_AFTER_MONTHS_MIN} to ${STALE_AFTER_MONTHS_MAX} whole months.`,
      );
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const stored = await tx.associationFacts.findUnique({
        where: { id: ROW_ID },
        select: { updatedAt: true, staleAfterMonths: true },
      });

      const saved =
        stored === null
          ? await tx.associationFacts.create({
              data: { id: ROW_ID, staleAfterMonths: months },
            })
          : await tx.associationFacts.update({
              where: { id: ROW_ID },
              data: { staleAfterMonths: months, updatedAt: stored.updatedAt },
            });

      await this.audit.record(
        {
          action: "ASSOCIATION_FACTS_STALE_AFTER_CHANGED",
          ...auditActor(actor),
          targetKind: "associationFacts",
          targetId: String(ROW_ID),
          context: {
            from: stored?.staleAfterMonths ?? STALE_AFTER_MONTHS_DEFAULT,
            to: months,
          },
        },
        tx,
      );

      return saved;
    });

    return toView(row);
  }

  private async runConfirmedHooks(
    tx: Prisma.TransactionClient,
    event: FactsConfirmedEvent,
  ): Promise<void> {
    for (const hook of this.confirmedHooks) {
      await hook(tx, event);
    }
  }
}

/**
 * Trims the submission and reads an emptied field as an unrecorded one.
 *
 * A field the board cleared holds "" or a line of spaces, and storing that
 * would put an empty answer under a label on the public page. Null is the one
 * representation of "the board has not said", whichever way the field got
 * there.
 */
function normalize(input: AssociationFactsInput): AssociationFactsInput {
  const data: AssociationFactsInput = {};

  for (const field of FACT_TEXT_FIELDS) {
    const value = input[field];
    if (value !== undefined) {
      const trimmed = value === null ? "" : value.trim().slice(0, MAX_TEXT);
      data[field] = trimmed === "" ? null : trimmed;
    }
  }

  for (const field of FACT_FLAG_FIELDS) {
    const value = input[field];
    if (value !== undefined) {
      data[field] = value;
    }
  }

  if (input.buildYear !== undefined) {
    data.buildYear = input.buildYear;
  }

  return data;
}

/**
 * Refuses facts carrying a Swedish personal identity number.
 *
 * The refusal names the field and where in it the value starts, and never the
 * value: a board that pasted a paragraph out of an email into "renovations"
 * has to be told which field to look at, and repeating the number back into a
 * response body, a log or a screen is the disclosure the rule exists to stop.
 */
function refusePersonalIdentityNumbers(data: AssociationFactsInput): void {
  const locations: FactTextLocation[] = [];

  for (const field of FACT_TEXT_FIELDS) {
    const value = data[field];
    if (typeof value !== "string") {
      continue;
    }
    for (const hit of scanForPersonalIdentityNumbers(value)) {
      locations.push({ field, offset: hit.index });
    }
  }

  if (locations.length > 0) {
    throw new AssociationFactsError(
      "The association facts carry a personal identity number and cannot be published.",
      "personal-identity-number",
      locations,
    );
  }
}

function toView(row: {
  propertyDesignation: string | null;
  buildYear: number | null;
  siteLeasehold: boolean | null;
  siteLeaseholdNote: string | null;
  feePolicy: string | null;
  feeIncludes: string | null;
  transferFeePolicy: string | null;
  pledgeFeePolicy: string | null;
  legalPersonOwners: boolean | null;
  legalPersonOwnersNote: string | null;
  parking: string | null;
  storage: string | null;
  renovations: string | null;
  updatedAt: Date;
  confirmedAt: Date | null;
  staleAfterMonths: number;
}): AssociationFactsView {
  return {
    propertyDesignation: row.propertyDesignation,
    buildYear: row.buildYear,
    siteLeasehold: row.siteLeasehold,
    siteLeaseholdNote: row.siteLeaseholdNote,
    feePolicy: row.feePolicy,
    feeIncludes: row.feeIncludes,
    transferFeePolicy: row.transferFeePolicy,
    pledgeFeePolicy: row.pledgeFeePolicy,
    legalPersonOwners: row.legalPersonOwners,
    legalPersonOwnersNote: row.legalPersonOwnersNote,
    parking: row.parking,
    storage: row.storage,
    renovations: row.renovations,
    // A row nobody has saved was created by the threshold and holds no fact,
    // so it has no date a fact was written either.
    updatedAt: row.confirmedAt === null ? null : row.updatedAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    staleAfterMonths: row.staleAfterMonths,
  };
}
