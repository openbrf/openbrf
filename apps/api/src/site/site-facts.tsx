import { Fragment, type ReactElement, type ReactNode } from "react";

import type { AssociationFactsView } from "./association-facts.service";
import type { SiteChrome } from "./site-html";

/**
 * The association's own recorded facts, as name-and-value rows.
 *
 * Extracted from the broker information page so the two places that publish
 * these facts - that page, and an association facts block on a page the board
 * writes - are one renderer and not two. A second copy would drift on the first
 * fact added, and the drift would be invisible: both pages would still render,
 * and one of them would be missing an answer the board had given.
 *
 * Pure, and it imports only a type from the document shell, so the shell can
 * import this without the two becoming a cycle.
 *
 * A fact nobody recorded renders as nothing at all. Not an empty label, not a
 * dash, not "not recorded" - the application's own NotRecorded sign is for a
 * board member who can go and fill the gap in, and the person reading this page
 * cannot. A whole group whose facts are all unrecorded loses its heading too,
 * so the page grows as the board answers rather than starting as a form.
 */

export interface BrokerPageInput {
  /** The association's own, and public: it is printed in the annual report. */
  organizationNumber: string | null;
  /**
   * How many apartments the association has, or null when there are none.
   *
   * Zero is not printed. An instance whose apartments have not been entered
   * yet would otherwise tell a broker the cooperative has none.
   */
  apartmentCount: number | null;
  facts: AssociationFactsView;
}

/**
 * The names this page puts in front of a value.
 *
 * Written out rather than taken as a string, so a mistyped key is a compile
 * error instead of a page showing the key itself: the API's translator is not
 * key-checked the way the client's is, and this is the one file where every
 * label goes through a single call.
 */
type BrokerLabelKey =
  | "association"
  | "organizationNumber"
  | "apartmentCount"
  | "propertyDesignation"
  | "buildYear"
  | "land"
  | "siteLeaseholdNote"
  | "parking"
  | "storage"
  | "renovations"
  | "feePolicy"
  | "feeIncludes"
  | "transferFeePolicy"
  | "pledgeFeePolicy"
  | "legalPersonOwners"
  | "legalPersonOwnersNote";

/** One name-and-value row on the page. */
interface FactRow {
  label: string;
  /** The value's own lines, in the order the board wrote them. */
  lines: string[];
}

/** A heading and the rows under it. Rendered only when it has rows. */
export interface FactGroup {
  heading: string | null;
  rows: FactRow[];
}

/**
 * The groups that have something in them, in the order they are read.
 *
 * Building the rows first and dropping the empty groups afterwards is what
 * keeps a heading from standing over nothing. It also means a fact added later
 * inherits the omission rule by being written the same way, rather than by
 * somebody remembering to guard its heading.
 */
export function associationFactGroups(
  chrome: SiteChrome,
  input: BrokerPageInput,
): FactGroup[] {
  const { t } = chrome;
  const { facts } = input;

  const label = (key: BrokerLabelKey): string => t(`site.broker.labels.${key}`);

  const groups: FactGroup[] = [
    {
      heading: null,
      rows: [
        // The association's own identity. Always present, and the reason the
        // broker page exists before a single fact has been recorded.
        { label: label("association"), lines: [chrome.associationName] },
        ...row(label("organizationNumber"), input.organizationNumber),
        ...row(
          label("apartmentCount"),
          input.apartmentCount === null || input.apartmentCount === 0
            ? null
            : String(input.apartmentCount),
        ),
      ],
    },
    {
      heading: t("site.broker.groups.property"),
      rows: [
        ...row(label("propertyDesignation"), facts.propertyDesignation),
        ...row(
          label("buildYear"),
          facts.buildYear === null ? null : String(facts.buildYear),
        ),
        ...row(
          label("land"),
          facts.siteLeasehold === null
            ? null
            : t(
                facts.siteLeasehold
                  ? "site.broker.values.leasehold"
                  : "site.broker.values.ownedLand",
              ),
        ),
        // Only where there is a leasehold to have terms. The board can answer
        // the two questions independently, so a note left behind by an earlier
        // answer would otherwise print "site leasehold terms" against land the
        // association owns - on the one page a broker takes at face value.
        ...(facts.siteLeasehold === true
          ? row(label("siteLeaseholdNote"), facts.siteLeaseholdNote)
          : []),
        ...row(label("parking"), facts.parking),
        ...row(label("storage"), facts.storage),
        ...row(label("renovations"), facts.renovations),
      ],
    },
    {
      heading: t("site.broker.groups.fees"),
      rows: [
        ...row(label("feePolicy"), facts.feePolicy),
        ...row(label("feeIncludes"), facts.feeIncludes),
        ...row(label("transferFeePolicy"), facts.transferFeePolicy),
        ...row(label("pledgeFeePolicy"), facts.pledgeFeePolicy),
      ],
    },
    {
      heading: t("site.broker.groups.membership"),
      rows: [
        ...row(
          label("legalPersonOwners"),
          facts.legalPersonOwners === null
            ? null
            : t(
                facts.legalPersonOwners
                  ? "site.broker.values.legalPersonsAccepted"
                  : "site.broker.values.legalPersonsRefused",
              ),
        ),
        ...row(label("legalPersonOwnersNote"), facts.legalPersonOwnersNote),
      ],
    },
  ];

  return groups.filter((group) => group.rows.length > 0);
}

/**
 * Whether the board has answered any of the questions at all.
 *
 * The identity group carries the association's name whether or not a single
 * fact has been recorded, so counting groups is not the same question as
 * counting answers: every recorded fact sits under a heading, and a heading is
 * therefore what says the board has said something.
 *
 * The broker page does not ask - it exists from the day the feature ships,
 * because an address a broker was given once must not answer "no such page".
 * A block on a page the board arranged is the other case: the board put it
 * there meaning to publish facts, and a block that rendered the association's
 * own name back at the reader and nothing else would read as a fault.
 */
export function hasRecordedFacts(groups: readonly FactGroup[]): boolean {
  return groups.some((group) => group.heading !== null);
}

/**
 * The groups as markup: a heading, then the pairs under it.
 *
 * The heading level is the caller's, because the two places these rows appear
 * sit at different depths. The broker page is a title and then the groups; a
 * block on a page the board wrote is a title, the block's own heading, and then
 * the groups. Passing the level keeps one document outline in each case, which
 * is what a screen reader navigates by.
 */
export function renderFactGroups(
  groups: readonly FactGroup[],
  headingLevel: 2 | 3 = 2,
): ReactElement[] {
  return groups.map((group, index) => (
    <Fragment key={index}>
      {group.heading === null ? null : headingLevel === 2 ? (
        <h2>{group.heading}</h2>
      ) : (
        <h3>{group.heading}</h3>
      )}
      <dl className="site-facts">
        {group.rows.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{renderValue(fact.lines)}</dd>
          </div>
        ))}
      </dl>
    </Fragment>
  ));
}

/**
 * One row, or none at all.
 *
 * Returned as a list so the caller can spread it: an unrecorded fact leaves no
 * row behind rather than a row the renderer has to remember to skip, which is
 * what keeps "a missing fact renders nothing" true of a fact added later
 * without anybody having to think about it.
 */
function row(label: string, value: string | null): FactRow[] {
  if (value === null) {
    return [];
  }
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length === 0 ? [] : [{ label, lines }];
}

/**
 * A value's lines, as paragraphs.
 *
 * The board writes a fee policy as prose and a renovation history as a list of
 * years, and the line breaks it typed are the only structure it has. HTML folds
 * them, so each line becomes its own paragraph rather than relying on a
 * white-space rule in the stylesheet - a theme is allowed to restyle this page
 * and none of them may be allowed to run the board's sentences together.
 *
 * Every line is a React child, so React escapes it: a fact containing markup is
 * shown as the characters the board typed.
 */
function renderValue(lines: readonly string[]): ReactNode {
  return lines.map((line, index) => <p key={index}>{line}</p>);
}
