import type { TFunction } from "i18next";

import type {
  DataSubjectReport,
  ReportDataSubjectRequest,
} from "../retention/data-subject-report";

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
 *   Data the person provided. Not what the association wrote about them: a
 *   board's note, a decision, an audit trail and a breach record are the
 *   association's own account and are on the report rather than here.
 *
 *   Processing on consent or contract (art. 20(1)(a)). The statutory registers
 *   rest on a legal obligation, so the member register, the apartment register,
 *   the transfers, the terminations, the lien notes, the reporting ledger and
 *   the meeting record are all outside art. 20 - and outside erasure too, for
 *   the same reason. The report lists them; this does not.
 *
 *   By automated means (art. 20(1)(b)), which a database trivially is.
 *
 * ## Why it is handed over rather than transmitted
 *
 * Art. 20(2) gives a right to have the data transmitted directly from one
 * controller to another "where technically feasible", and Recital 68 says that
 * creates no obligation to adopt or maintain compatible systems. There is no
 * receiving standard between housing cooperative platforms, so the export is
 * handed to the person and they transmit it. The file says so itself.
 */
export interface DataPortabilityExport {
  /** What this file is, in the person's own file. */
  about: {
    /** GDPR art. 20, so a reader knows what they are holding. */
    right: "GDPR art. 20";
    generatedOn: string;
    association: string;
    /** Why there is no direct transfer: Recital 68, in one sentence. */
    transmission: string;
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
  publicationConsents: DataSubjectReport["publicationConsents"];
  issues: DataSubjectReport["issues"];
  documents: DataSubjectReport["documents"];
  bookings: DataSubjectReport["bookings"];
  motions: DataSubjectReport["motions"];
  eventSignups: DataSubjectReport["eventSignups"];
  newsComments: DataSubjectReport["newsComments"];
  /**
   * What they have asked about their own data.
   *
   * What they asked and why, and not what the board answered. A decision, its
   * ground and the dates it carries are the association's own account, which
   * this file excludes for the same reason it excludes a board's note and a
   * breach record. The access report carries all of it.
   */
  dataSubjectRequests: PortableDataSubjectRequest[];
}

/** One request, narrowed to what the person themselves supplied. */
export interface PortableDataSubjectRequest {
  requestId: string;
  kind: ReportDataSubjectRequest["kind"];
  requestedOn: string | null;
  ground: string;
  erasureGround: ReportDataSubjectRequest["erasureGround"];
  /** The issue whose description names them, where that is what it was about. */
  issueId: string | null;
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
 * Narrows the access report to what art. 20 covers.
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
    publicationConsents: report.publicationConsents,
    issues: report.issues,
    documents: report.documents,
    bookings: report.bookings,
    motions: report.motions,
    eventSignups: report.eventSignups,
    newsComments: report.newsComments,
    dataSubjectRequests: report.dataSubjectRequests.map((request) => ({
      requestId: request.requestId,
      kind: request.kind,
      requestedOn: request.requestedOn,
      ground: request.ground,
      erasureGround: request.erasureGround,
      issueId: request.issueId,
    })),
  };
}
