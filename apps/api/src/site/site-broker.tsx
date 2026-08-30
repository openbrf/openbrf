import { Fragment, type ReactNode } from "react";

import type { AssociationFactsView } from "./association-facts.service";
import { renderDocument, type SiteChrome } from "./site-html";

/**
 * The broker information page (maklarinfo), as HTML.
 *
 * A generated page rather than one the board writes: the association records
 * the facts once on its own screen, and this file turns them into the page a
 * broker or a prospective buyer reads. Pure in the same way site-html.tsx is -
 * it is handed everything it needs and reads nothing.
 *
 * What it renders is board-entered facts, the association's own name and
 * organisation number, and the number of apartments. That list is exhaustive
 * and it is the whole safety argument for this page. A broker asks questions
 * the statutory registers could answer - who owns which apartment, what the
 * share capital is, what a lien note says - and none of them are answered here
 * or can be: this module imports nothing from the registers, the address book
 * or the encryption layer, and neither does anything it calls. The paid
 * transactional broker extract (maklarbild) is a different product and is out
 * of core precisely because it needs what this page may not have.
 *
 * The apartment count is the one number not typed by a board member, and it is
 * counted rather than listed: how many apartments a housing cooperative has is
 * a fact about the association, printed in its annual report, while anything
 * per-apartment is register content. The count is computed at render time by
 * the caller, and the boundary it sits against is named where the query is.
 *
 * A fact nobody recorded renders as nothing at all. Not an empty label, not a
 * dash, not "not recorded" - the application's own NotRecorded sign is for a
 * board member who can go and fill the gap in, and the person reading this page
 * cannot. A whole group whose facts are all unrecorded loses its heading too,
 * so the page grows as the board answers rather than starting as a form.
 *
 * The page exists from the moment the feature ships. An association that has
 * recorded nothing gets a page carrying its name and its organisation number,
 * rather than a 404 that turns into a page the first time a board member saves
 * something: an address that starts answering is an address somebody has
 * already linked to and had answered with "no such page", and a broker who
 * checked once would have no reason to check again.
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
interface FactGroup {
  heading: string | null;
  rows: FactRow[];
}

/**
 * The broker information page, as a whole document.
 *
 * Rendered in the association's own language rather than the visitor's, which
 * is the one place on the website where those differ. Site content is
 * monolingual (decision 59): a board writes its fee policy in the language the
 * association keeps its books in, and it is stored and served exactly as
 * written. Translating the labels around it would produce a page whose
 * questions are in one language and whose answers are in another, and whose
 * lang attribute would be a lie about half of it.
 */
export function renderBrokerPage(
  chrome: SiteChrome,
  input: BrokerPageInput,
): string {
  const title = chrome.t("site.broker.title");

  return renderDocument(
    chrome,
    title,
    <>
      <h1 className="site-title">{title}</h1>
      {brokerGroups(chrome, input).map((group, index) => (
        <Fragment key={index}>
          {group.heading === null ? null : <h2>{group.heading}</h2>}
          <dl className="site-facts">
            {group.rows.map((row) => (
              <div key={row.label}>
                <dt>{row.label}</dt>
                <dd>{renderValue(row.lines)}</dd>
              </div>
            ))}
          </dl>
        </Fragment>
      ))}
    </>,
  );
}

/**
 * The groups that have something in them, in the order they are read.
 *
 * Building the rows first and dropping the empty groups afterwards is what
 * keeps a heading from standing over nothing. It also means a fact added later
 * inherits the omission rule by being written the same way, rather than by
 * somebody remembering to guard its heading.
 */
function brokerGroups(chrome: SiteChrome, input: BrokerPageInput): FactGroup[] {
  const { t } = chrome;
  const { facts } = input;

  const label = (key: BrokerLabelKey): string => t(`site.broker.labels.${key}`);

  const groups: FactGroup[] = [
    {
      heading: null,
      rows: [
        // The association's own identity. Always present, and the reason the
        // page exists before a single fact has been recorded.
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
