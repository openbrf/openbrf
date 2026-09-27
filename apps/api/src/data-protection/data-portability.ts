import type { TFunction } from "i18next";

import type {
  DataSubjectReport,
  ReportConnectedAppScope,
  ReportKeyOrder,
} from "../retention/data-subject-report";
import type { PortableSection } from "./section-processing";

/**
 * What a person may take with them under GDPR art. 20, projected from the
 * access report.
 *
 * A projection rather than a second gathering, deliberately. The access report
 * already knows how to find everything the association holds about one person,
 * and a second query layer beside it would be the place the two drifted apart -
 * a row added to the report and forgotten here would be data the person could
 * read but not take.
 *
 * ## Why this is narrower than the report
 *
 * Art. 20 is not art. 15. The access report answers "what do you hold about
 * me"; this answers "give me back what I gave you", and the article bounds it
 * three ways:
 *
 *   Processing on consent or contract (art. 20(1)(a)). Read section by section
 *   from the record of processing activities: `section-processing.ts` maps
 *   every section of the access report to the row that covers it, and this file
 *   carries exactly the sections the map marks carried. A section whose row
 *   rests on anything else stays on the report. Besides the statutory registers
 *   - the member register, the apartment register, the transfers, the
 *   terminations, the lien notes, the reporting ledger and the meeting record,
 *   which rest on a legal obligation and are outside erasure for the same
 *   reason - that leaves out the issue reports, the document archive, the
 *   apartment binder, the chat, comments on news, the board mailbox and the
 *   positions of trust, which rest on the association's legitimate interest,
 *   and the charges, the fees and the association's own data protection
 *   records, which rest on a legal obligation. The access report lists them
 *   all; this does not.
 *
 *   Data the person provided. Judged per section, and recorded in the map as
 *   "notProvided" where a section rests on the contract and is still the
 *   association's own account - the account's creation and its second factor.
 *   Within a carried section, a board's note, a decision and a closing date are
 *   the association's own account too, and are left out field by field.
 *
 *   By automated means (art. 20(1)(b)), which a database trivially is.
 *
 * The file says what it carries and where the rest is, for the reason it says
 * why it is a file rather than a transfer: it outlives the screen.
 *
 * ## Why it is handed over rather than transmitted
 *
 * Art. 20(2) gives a right to have the data transmitted directly from one
 * controller to another "where technically feasible", and Recital 68 says that
 * creates no obligation to adopt or maintain compatible systems. There is no
 * receiving standard between housing cooperative platforms, so the export is
 * handed to the person and they transmit it. The file says so itself.
 *
 * ## Typed against the map
 *
 * Every section the map marks carried is a property of this type, so a carried
 * section the type forgets fails to compile, and the spec holds the projection
 * to exactly those sections.
 */
export interface DataPortabilityExport extends Record<
  PortableSection,
  unknown
> {
  /** What this file is, in the person's own file. */
  about: {
    /** GDPR art. 20, so a reader knows what they are holding. */
    right: "GDPR art. 20";
    generatedOn: string;
    association: string;
    /** Why there is no direct transfer: Recital 68, in one sentence. */
    transmission: string;
    /**
     * What the file carries, that what rests on another basis is not in it,
     * and that the board produces the data subject access report (art. 15) on
     * request.
     */
    scope: string;
  };
  person: {
    personId: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    postalAddress: DataSubjectReport["person"]["postalAddress"];
    alternativePostalAddress: string | null;
    preferredLocale: string;
  };
  residencies: DataSubjectReport["residencies"];
  /**
   * The apps they allowed to act for them, and what each may do.
   *
   * The record puts connected apps on the contract: the connection is part of
   * the service the person asked for. Which apps somebody connected and what
   * they allowed each of them is their own decision rather than the
   * association's account of them.
   */
  connectedApps: PortableConnectedApp[];
  publicationConsents: DataSubjectReport["publicationConsents"];
  bookings: DataSubjectReport["bookings"];
  motions: DataSubjectReport["motions"];
  /** What they asked the board's permission for, and why. */
  subletApplications: PortableSubletApplication[];
  /** What they ordered, how many, and what they said it was for. */
  keyOrders: PortableKeyOrder[];
  eventSignups: DataSubjectReport["eventSignups"];
}

/**
 * One sublet application, narrowed to what the person themselves supplied.
 *
 * The period and the reason are theirs: they wrote them into the form. The
 * board's answer is not - `decisionNote` and the rent tribunal's permission are
 * the association's own account of what it decided about this person, which the
 * access report carries and art. 20(1) does not reach.
 */
export interface PortableSubletApplication {
  applicationId: string;
  /** Null where the apartment has since been corrected out of the register. */
  apartment: string | null;
  /** "YYYY-MM-DD". */
  periodFrom: string;
  /** "YYYY-MM-DD", inclusive. */
  periodTo: string;
  reason: string;
  /** ISO instant. */
  submittedAt: string;
}

/**
 * One connected app, narrowed to the grant the person gave.
 *
 * Nothing from a token row, and `lastUsedAt` is the field that says so. A token
 * row holds a digest of a live credential, which never leaves the instance in
 * any form; and when the association last issued one is the association's own
 * observation of the connection working rather than something the person
 * provided, which is the same line that keeps a board's note off the
 * subletting applications and the key orders.
 */
export interface PortableConnectedApp {
  /** As the client declared itself, or null where it declared no name. */
  clientName: string | null;
  /** The host it is reached at, or null where it names no URL that parses. */
  clientHost: string | null;
  scopes: ReportConnectedAppScope[];
  /** ISO instant the person consented. */
  connectedAt: string;
}

/** One key or tag order, narrowed the same way: not the board's `boardNote`. */
export interface PortableKeyOrder {
  orderId: string;
  /** Null where the apartment has since been corrected out of the register. */
  apartment: string | null;
  kind: ReportKeyOrder["kind"];
  quantity: number;
  /** What the resident said it was for, where they said anything. */
  note: string | null;
  /** ISO instant. */
  submittedAt: string;
}

/**
 * The sentence the export carries about why it is a file rather than a
 * transfer.
 *
 * In the file itself rather than only on the screen that produced it, because
 * the file outlives the screen: somebody opening it a year later should be able
 * to tell what it is and what it is not.
 *
 * In the recipient's own language, like every other prose the product hands a
 * person. The article citation beside it stays as it is: "GDPR art. 20" is a
 * legal identifier and reads the same in both.
 */
export const TRANSMISSION_NOTE_KEY = "dataProtection.portability.transmission";

/**
 * The sentence the export carries about what it holds and where the rest is.
 *
 * In the file for the reason {@link TRANSMISSION_NOTE_KEY} is: somebody opening
 * it a year later, and missing the chat or their issue reports, should find in
 * it that those are on the data subject access report, and why.
 */
export const SCOPE_NOTE_KEY = "dataProtection.portability.scope";

/**
 * Narrows the access report to what art. 20 covers: the sections the map marks
 * carried, in the report's order.
 *
 * The personal identity number is deliberately absent although the person gave
 * it. It is confidential apartment register content under BRL 9 kap., held on a
 * legal obligation rather than on consent or contract, and the product's rule
 * throughout is that it leaves the register only through the audited reveal -
 * never into a file a browser downloads.
 */
export function toDataPortabilityExport(
  report: DataSubjectReport,
  t: TFunction,
): DataPortabilityExport {
  return {
    about: {
      right: "GDPR art. 20",
      generatedOn: report.generatedOn,
      association: report.housingCooperative.name,
      transmission: t(TRANSMISSION_NOTE_KEY),
      scope: t(SCOPE_NOTE_KEY),
    },
    person: {
      personId: report.person.personId,
      firstName: report.person.firstName,
      lastName: report.person.lastName,
      email: report.person.email,
      phone: report.person.phone,
      postalAddress: report.person.postalAddress,
      alternativePostalAddress: report.person.alternativePostalAddress,
      preferredLocale: report.person.preferredLocale,
    },
    residencies: report.residencies,
    connectedApps: report.connectedApps.map((app) => ({
      clientName: app.clientName,
      clientHost: app.clientHost,
      scopes: app.scopes,
      connectedAt: app.connectedAt,
    })),
    publicationConsents: report.publicationConsents,
    bookings: report.bookings,
    motions: report.motions,
    subletApplications: report.subletApplications.map((application) => ({
      applicationId: application.applicationId,
      apartment: application.apartment,
      periodFrom: application.periodFrom,
      periodTo: application.periodTo,
      reason: application.reason,
      submittedAt: application.submittedAt,
    })),
    keyOrders: report.keyOrders.map((order) => ({
      orderId: order.orderId,
      apartment: order.apartment,
      kind: order.kind,
      quantity: order.quantity,
      note: order.note,
      submittedAt: order.submittedAt,
    })),
    eventSignups: report.eventSignups,
  };
}
