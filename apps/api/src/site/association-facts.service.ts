import { HttpStatus, Injectable } from "@nestjs/common";
import { scanForPersonalIdentityNumbers } from "@openbrf/shared";

import { PrismaService } from "../database/prisma.service";
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

export type AssociationFactsView = Record<FactTextField, string | null> &
  Record<FactFlagField, boolean | null> & {
    buildYear: number | null;
    /** ISO instant, or null while the board has recorded nothing at all. */
    updatedAt: string | null;
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
};

@Injectable()
export class AssociationFactsService {
  constructor(private readonly prisma: PrismaService) {}

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
   */
  async save(input: AssociationFactsInput): Promise<AssociationFactsView> {
    const data = normalize(input);
    refusePersonalIdentityNumbers(data);

    const row = await this.prisma.associationFacts.upsert({
      where: { id: ROW_ID },
      create: { id: ROW_ID, ...data },
      update: data,
    });
    return toView(row);
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
    updatedAt: row.updatedAt.toISOString(),
  };
}
