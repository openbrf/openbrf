import type { TFunction } from "i18next";

import type {
  DataSubjectCategory,
  PersonalDataCategory,
} from "@openbrf/shared";

import type {
  LegalBasis,
  ProcessingActivitySource,
} from "../generated/prisma/enums";
import type { ProcessorFacts } from "./processors";

/**
 * What the instance already knows about its own processing, written into the
 * record GDPR art. 30 requires.
 *
 * A board asked to fill in a blank record of processing activities would be
 * asked to reverse-engineer the product: which tables hold personal data, on
 * what basis each is kept, and how long. The instance knows all of that about
 * itself, so it writes the record and the board corrects and extends it. That
 * is the difference between a record that describes what the association
 * actually does and one that describes what somebody guessed on a Sunday.
 *
 * Three kinds of field, and the distinction governs what the seed may overwrite:
 *
 *   - Fixed text (name, purpose, legal basis, categories, retention), in the
 *     association's own language.
 *   - Fact-derived (recipients, third-country transfer and its safeguards, the
 *     security measures), read from the instance's settings.
 *   - The board's own (a BOARD row, or a seeded row it has edited). Never
 *     touched.
 *
 * The first two are written at first seed and refreshed on every seed after it,
 * but only while `updatedByPersonId` is null (`ProcessingActivityService.seed`):
 * a changed storage driver or a corrected wording should show up in the record,
 * and a board's own wording should never be overwritten by a background job.
 *
 * The keys below are fixed and asserted by the spec. Adding a table that holds
 * personal data means adding a row here: that is the point of a checked list
 * rather than a derivation, and a processing the record does not mention is the
 * failure art. 30 exists to prevent. The rule is enforced from the other side
 * too: every section of the data subject access report names the row that
 * covers it in `section-processing.ts`, whose `satisfies` fails to compile for a
 * section that names none and whose spec fails for a row no section reaches
 * without a stated reason.
 */

/** One row as the seed describes it, before it is written. */
export interface SeedRow {
  sourceKey: string;
  source: ProcessingActivitySource;
  name: string;
  purpose: string;
  legalBasis: LegalBasis;
  legalBasisNote: string | null;
  dataSubjectCategories: DataSubjectCategory[];
  personalDataCategories: PersonalDataCategory[];
  recipients: string | null;
  thirdCountryTransfer: boolean;
  thirdCountrySafeguards: string | null;
  retention: string;
  securityMeasures: string;
}

/**
 * Every processing the instance itself performs.
 *
 * The order is the order the rows are seeded in, and the order a reader of this
 * file meets them: the statutory registers first, because they are what the
 * association exists to keep and what it may never erase, then the service data
 * in the order a resident meets it, then the association's own data protection
 * records. The screen orders the record by source and name instead.
 */
export const SEED_KEYS = [
  "memberRegister",
  "apartmentRegister",
  "cooperativeHousingRegisterReporting",
  "meetingRecords",
  "auditLog",
  "addressBookAndAccounts",
  "boardPositionsAndSystemRoles",
  "connectedApps",
  "residentDirectory",
  "newsMailings",
  "newsComments",
  "issues",
  "documents",
  "apartmentBinder",
  "bookings",
  "events",
  "motions",
  "subletApplications",
  "keyOrders",
  "chat",
  "boardMailbox",
  "fees",
  "memberCharges",
  "websitePublication",
  "contactSubmissions",
  "signupRequestsAndInvitations",
  "dataSubjectRequests",
  "personalDataBreaches",
  "legalHolds",
] as const;

export type SeedKey = (typeof SEED_KEYS)[number];

interface SeedShape {
  source: ProcessingActivitySource;
  legalBasis: LegalBasis;
  dataSubjectCategories: DataSubjectCategory[];
  personalDataCategories: PersonalDataCategory[];
}

/**
 * The part of each row that is a fact about the product rather than about this
 * instance: which tier it belongs to, what it rests on, and whose data it is.
 */
const SHAPES: Record<SeedKey, SeedShape> = {
  memberRegister: {
    source: "STATUTORY_REGISTER",
    legalBasis: "LEGAL_OBLIGATION",
    dataSubjectCategories: ["member", "formerResident"],
    personalDataCategories: ["name", "postalAddress"],
  },
  apartmentRegister: {
    source: "STATUTORY_REGISTER",
    legalBasis: "LEGAL_OBLIGATION",
    dataSubjectCategories: ["member", "formerResident"],
    personalDataCategories: [
      "name",
      "apartment",
      "personalIdentityNumber",
      "financial",
    ],
  },
  cooperativeHousingRegisterReporting: {
    source: "STATUTORY_REGISTER",
    legalBasis: "LEGAL_OBLIGATION",
    dataSubjectCategories: ["member"],
    personalDataCategories: ["name", "apartment", "personalIdentityNumber"],
  },
  meetingRecords: {
    source: "STATUTORY_REGISTER",
    legalBasis: "LEGAL_OBLIGATION",
    dataSubjectCategories: ["member", "boardMember"],
    personalDataCategories: ["name", "apartment", "freeText"],
  },
  auditLog: {
    source: "STATUTORY_REGISTER",
    legalBasis: "LEGAL_OBLIGATION",
    dataSubjectCategories: ["member", "resident", "boardMember", "external"],
    personalDataCategories: ["auditTrail"],
  },
  addressBookAndAccounts: {
    source: "SERVICE_DATA",
    legalBasis: "CONTRACT",
    dataSubjectCategories: ["member", "resident", "formerResident"],
    personalDataCategories: [
      "name",
      "apartment",
      "residency",
      "email",
      "phone",
      "account",
    ],
  },
  /*
   * Who holds a seat on the board, and who holds a role on the instance. A
   * processing of its own rather than a part of the address book: a position of
   * trust is kept as the record of who sat on the board and when long after the
   * term has ended, which is not what the address book keeps anything for, and
   * the property manager holding a system role is none of the people the
   * address book describes. Legitimate interest rather than the contract for
   * the same reason - the property manager is party to no contract with the
   * association - and because being able to say afterwards who answered for it
   * when a decision was taken is the association's own interest.
   *
   * Former residents because a position is history and outlives the residency;
   * external for the property manager.
   */
  boardPositionsAndSystemRoles: {
    source: "SERVICE_DATA",
    legalBasis: "LEGITIMATE_INTEREST",
    dataSubjectCategories: [
      "boardMember",
      "member",
      "resident",
      "formerResident",
      "external",
    ],
    /*
     * The name. A seat, its dates and a role have no category of their own in
     * the shared vocabulary, and `account` - sign-in credentials and sessions -
     * would claim something these tables do not hold.
     */
    personalDataCategories: ["name"],
  },
  connectedApps: {
    source: "SERVICE_DATA",
    legalBasis: "CONTRACT",
    /*
     * Anybody who can sign in can connect an app, so the subjects are whoever
     * holds an account rather than the members alone - and "external" because
     * the client acts for one of them from outside the instance.
     */
    dataSubjectCategories: ["member", "resident", "boardMember", "external"],
    /*
     * The grant and the tokens behind it, which is account data. What an app
     * then reads is whatever the person themselves may read, and that is held
     * by the processing it is read from rather than by this one - a row
     * claiming every category in the product would say nothing true about what
     * these tables hold.
     */
    personalDataCategories: ["account"],
  },
  residentDirectory: {
    source: "SERVICE_DATA",
    legalBasis: "LEGITIMATE_INTEREST",
    dataSubjectCategories: ["member", "resident"],
    personalDataCategories: ["name", "apartment"],
  },
  newsMailings: {
    source: "SERVICE_DATA",
    legalBasis: "LEGITIMATE_INTEREST",
    dataSubjectCategories: ["member", "resident"],
    personalDataCategories: ["name", "email", "phone"],
  },
  /*
   * What the people who live here write under a news item. Legitimate interest,
   * as the chat is, the nearest processing to it: a comment function is not
   * objectively necessary to the membership, and letting the house talk under
   * what the board publishes is the association's interest rather than a term
   * of anybody's contract.
   *
   * The board member who hid a comment is named on it. And whoever has moved: a
   * comment is erased a year after it was written and on nothing else, so what
   * somebody wrote outlives their residency, as a chat message does.
   */
  newsComments: {
    source: "SERVICE_DATA",
    legalBasis: "LEGITIMATE_INTEREST",
    dataSubjectCategories: [
      "member",
      "resident",
      "boardMember",
      "formerResident",
    ],
    // Who wrote, and what they wrote: the chat row's categories, and for the
    // same reason.
    personalDataCategories: ["name", "freeText"],
  },
  issues: {
    source: "SERVICE_DATA",
    legalBasis: "LEGITIMATE_INTEREST",
    dataSubjectCategories: ["member", "resident", "external"],
    personalDataCategories: [
      "name",
      "apartment",
      "email",
      "freeText",
      "photograph",
      "health",
    ],
  },
  documents: {
    source: "SERVICE_DATA",
    legalBasis: "LEGITIMATE_INTEREST",
    dataSubjectCategories: ["member", "boardMember"],
    personalDataCategories: ["name"],
  },
  apartmentBinder: {
    source: "SERVICE_DATA",
    legalBasis: "LEGITIMATE_INTEREST",
    /*
     * Whoever lives here, and whoever used to. The link to the person who filed
     * an entry is detached on their own retention window rather than on the day
     * they move out, so what they filed is still held, and still on their
     * access report, long after they have left - and the entry itself stays
     * with the apartment for good. A record naming only the people who are here
     * would describe a processing that stops when somebody leaves, and this one
     * does not. The chat row says the same of itself.
     */
    dataSubjectCategories: [
      "member",
      "resident",
      "boardMember",
      "formerResident",
    ],
    /*
     * `health` on the issue row's precedent, and for the same reason: the
     * record of a bathroom adapted for a disability is health data whether or
     * not anybody meant it to be, and a binder is where the papers about that
     * bathroom are kept. `freeText` is the title, which whoever files an entry
     * writes themselves and which is scanned for a personal identity number.
     */
    personalDataCategories: ["name", "apartment", "freeText", "health"],
  },
  bookings: {
    source: "SERVICE_DATA",
    legalBasis: "CONTRACT",
    dataSubjectCategories: ["member", "resident"],
    personalDataCategories: ["name", "apartment"],
  },
  events: {
    source: "SERVICE_DATA",
    legalBasis: "CONTRACT",
    dataSubjectCategories: ["member", "resident"],
    personalDataCategories: ["name", "apartment", "freeText"],
  },
  /*
   * A legal obligation rather than the contract the bookings and events rest
   * on, although the fee itself is owed under the membership. The processing
   * this row describes is keeping the rate and the notice as accounting
   * records: they are rakenskapsinformation under bokforingslagen 5 kap.
   * 6-7 §§, the association is bokforingsskyldig under 2 kap. 1 §, and 7 kap.
   * 2 § is what fixes how long they are kept. The contract would not explain
   * why a notice outlives the residency it was issued to.
   *
   * The resident as well as the member. The arsavgift is the
   * bostadsrattshavare's under BRL 7 kap. 14 §, but a rate and a notice name an
   * apartment, and an apartment says something about everybody living in it:
   * the data subject access report carries both to anybody whose residency
   * overlaps them, whatever its role, so a partner or a tenant living there is
   * a data subject of this processing too. The former resident is here because
   * the window outlives the residency by years.
   */
  fees: {
    source: "SERVICE_DATA",
    legalBasis: "LEGAL_OBLIGATION",
    dataSubjectCategories: ["member", "resident", "formerResident"],
    personalDataCategories: ["name", "apartment", "financial"],
  },
  /*
   * A legal obligation, for the reason the fees row gives and on the same
   * statute. A charge records a receivable arising, which is an affärshändelse
   * (bokföringslagen (1999:1078) 1 kap. 2 § första stycket 7); every
   * affärshändelse needs a verifikation (5 kap. 6 §); what documents it is
   * räkenskapsinformation (1 kap. 2 § första stycket 9), kept through the
   * seventh year after the calendar year the financial year ended (7 kap. 2 §);
   * and the association is bokföringsskyldig (2 kap. 1 §). The contract would
   * not explain why a charge outlives the residency by seven years.
   *
   * The resident as well as the member, as on the fees row: a charge put on an
   * apartment says something about everybody living in it. The former resident
   * because the window outlives the residency; the board member because the one
   * who recorded the charge is named on it.
   */
  memberCharges: {
    source: "SERVICE_DATA",
    legalBasis: "LEGAL_OBLIGATION",
    dataSubjectCategories: [
      "member",
      "resident",
      "formerResident",
      "boardMember",
    ],
    // The sum, and the reason for it, which the board writes in its own words.
    personalDataCategories: ["name", "apartment", "financial", "freeText"],
  },
  motions: {
    source: "SERVICE_DATA",
    legalBasis: "CONTRACT",
    dataSubjectCategories: ["member"],
    personalDataCategories: ["name", "apartment", "freeText"],
  },
  /*
   * The contract, and not a legal obligation although a statute stands behind
   * it. BRL 7 kap. 10 § lets a bostadsrättshavare sublet only with the board's
   * consent, and the application and the answer are that consent asked for and
   * given or refused - a step in the tenure the member holds. 10 § conditions
   * the holder's right and puts no duty on the association to process anything,
   * and art. 6(3) asks for the obligation itself to be laid down in law. The
   * motions row is the precedent: a statutory right exercised within the
   * membership, recorded as the contract.
   *
   * The applicant is the tenant-owner, and the board member who answered is
   * named on the row. The former resident because the application is kept two
   * years past the letting. And external: the sublessee is not recorded, but is
   * who the reason is about, and whose number turns up pasted into it.
   */
  subletApplications: {
    source: "SERVICE_DATA",
    legalBasis: "CONTRACT",
    dataSubjectCategories: [
      "member",
      "boardMember",
      "formerResident",
      "external",
    ],
    /*
     * `health` on the issue and binder rows' precedent: the reason the form asks
     * for is what 11 § weighs, and illness and care are among the ordinary
     * reasons somebody lets their home.
     */
    personalDataCategories: ["name", "apartment", "freeText", "health"],
  },
  /*
   * The key or tag a household asked the association for. No statute stands
   * behind it, so the contract, on the precedent of the bookings and events
   * rows: a service a resident asks for. A resident rather than only a member,
   * because anybody living here may order one; the board member who handed it
   * over is named on the row; and whoever has moved, because a closed order is
   * kept a year whatever became of the household.
   */
  keyOrders: {
    source: "SERVICE_DATA",
    legalBasis: "CONTRACT",
    dataSubjectCategories: [
      "member",
      "resident",
      "boardMember",
      "formerResident",
    ],
    personalDataCategories: ["name", "apartment", "freeText"],
  },
  chat: {
    source: "SERVICE_DATA",
    legalBasis: "LEGITIMATE_INTEREST",
    /*
     * The board and whoever lives here. There are two kinds of room: the board
     * chat, whose members are whoever holds a seat, and a group, which somebody
     * living here made for something the house is doing. Both are rooms this
     * instance holds text in, so both belong in the record.
     *
     * And whoever used to. A message is erased a year after it was written and
     * on nothing else - not on the residency that has ended, not on the seat
     * that was not re-elected - so what somebody wrote is still held, and still
     * on their access report, long after they have left. A record naming only
     * the people who are here would describe a processing that stops when a
     * person leaves, and this one does not.
     */
    dataSubjectCategories: [
      "member",
      "resident",
      "boardMember",
      "formerResident",
    ],
    /*
     * Who wrote, and what they wrote. `freeText` is the substance of the
     * processing rather than a footnote: a message is text somebody composed
     * themselves and it may name anybody in the building, which is why the
     * write is scanned for a personal identity number and why the room is
     * erased on a clock of its own. A group's name, and the note somebody
     * writes when they report a message to the board, are the same kind of
     * text under the same rule.
     */
    personalDataCategories: ["name", "freeText"],
  },
  /*
   * What is written to the board's address, and what the board answers.
   * Legitimate interest: dealing with what the association is asked and
   * answering whoever wrote. No statute obliges the association to keep a shared
   * inbox, and most correspondents have no contract with it at all.
   *
   * Whoever writes in, which is mostly somebody outside the register - a bank, a
   * contractor, an authority, a neighbour in the next building. A member or a
   * resident where they write themselves, and a former one because the thread
   * is kept two years from its last message whoever has moved. The board member
   * who takes, answers and closes a thread is named on it.
   */
  boardMailbox: {
    source: "SERVICE_DATA",
    legalBasis: "LEGITIMATE_INTEREST",
    dataSubjectCategories: [
      "external",
      "member",
      "resident",
      "formerResident",
      "boardMember",
    ],
    /*
     * The address and the name the sender gave, the subject and the bodies in
     * both directions, and the attachments, whose images are stored as showing
     * identifiable persons. A letter to a board is whatever somebody chose to
     * write - money, health, a dispute with a neighbour and a third party's
     * details - so `financial` and `health` are here the way `health` is on the
     * issue row: nobody asks for them, and a record that could not say they
     * arrive would describe the processing inaccurately.
     */
    personalDataCategories: [
      "name",
      "email",
      "freeText",
      "photograph",
      "financial",
      "health",
    ],
  },
  websitePublication: {
    source: "SERVICE_DATA",
    legalBasis: "CONSENT",
    dataSubjectCategories: ["member", "resident", "boardMember"],
    personalDataCategories: ["name", "photograph"],
  },
  contactSubmissions: {
    source: "SERVICE_DATA",
    legalBasis: "LEGITIMATE_INTEREST",
    dataSubjectCategories: ["external"],
    personalDataCategories: ["name", "email", "freeText"],
  },
  signupRequestsAndInvitations: {
    source: "SERVICE_DATA",
    legalBasis: "LEGITIMATE_INTEREST",
    dataSubjectCategories: ["applicant"],
    personalDataCategories: ["name", "email", "freeText"],
  },
  /*
   * The association's own data protection records. Processing personal data to
   * comply with the GDPR is processing (art. 4(2)), and art. 30(1) asks for all
   * of it, so each has a row of its own with its own purpose and basis rather
   * than one row with two bases, which the record exists to keep apart.
   *
   * Requests about own data on a legal obligation: art. 12(3)-(4) has the
   * association answer within a month and give its reasons for a refusal, under
   * art. 17, 18 and 21, and art. 5(2) has it able to show that it did. Union
   * law, which art. 6(3)(a) accepts; the audit log row cites the GDPR the same
   * way. Former residents because a request is closed with a date and kept; the
   * board member who decided is named on it.
   */
  dataSubjectRequests: {
    source: "SERVICE_DATA",
    legalBasis: "LEGAL_OBLIGATION",
    dataSubjectCategories: [
      "member",
      "resident",
      "formerResident",
      "boardMember",
    ],
    // The person's own ground and the board's decision ground.
    personalDataCategories: ["name", "freeText"],
  },
  /*
   * Art. 33(5): "The controller shall document any personal data breaches",
   * with the decisions under art. 33(1) and 34(1). The people a breach reached
   * are register persons, and the board decides.
   */
  personalDataBreaches: {
    source: "SERVICE_DATA",
    legalBasis: "LEGAL_OBLIGATION",
    dataSubjectCategories: [
      "member",
      "resident",
      "formerResident",
      "boardMember",
    ],
    personalDataCategories: ["name", "freeText"],
  },
  /*
   * Legitimate interest: establishing, exercising or defending a legal claim,
   * or answering an authority's request. Art. 17(3)(b) and (e) disapply erasure
   * rather than supplying a basis for processing, which the association still
   * needs under art. 6. The board member who placed and released the hold is
   * named on it.
   */
  legalHolds: {
    source: "SERVICE_DATA",
    legalBasis: "LEGITIMATE_INTEREST",
    dataSubjectCategories: [
      "member",
      "resident",
      "formerResident",
      "boardMember",
    ],
    // The reason the hold was placed.
    personalDataCategories: ["name", "freeText"],
  },
};

/**
 * The basis the product states for a row: the processing's own, not an
 * instance's edited copy of it.
 *
 * Read by the portability export's test, which ties each section the export
 * carries to its row's basis. A board that edits the basis on its own record
 * changes its record, not what the product exports.
 */
export function legalBasisOf(key: SeedKey): LegalBasis {
  return SHAPES[key].legalBasis;
}

/**
 * Which seeded rows store files, and so name the storage recipient. The board
 * mailbox stores its attachments through the ordinary upload path.
 */
const STORAGE_BACKED: readonly SeedKey[] = [
  "issues",
  "documents",
  "apartmentBinder",
  "websitePublication",
  "boardMailbox",
];

/** Which seeded rows send a person a message, and so name mail and SMS. */
const MESSAGE_SENDING: readonly SeedKey[] = ["newsMailings"];

/**
 * Which seeded rows hold letters collected from the association's mailbox, and
 * so name it. Every letter stays there after the thread is erased, because the
 * instance never deletes one at the provider.
 */
const MAILBOX_BACKED: readonly SeedKey[] = ["boardMailbox"];

/**
 * Which seeded rows' basis goes to whoever keeps the books, and so name the
 * economic manager. A fixed sentence rather than a name: the instance holds no
 * setting that names the manager, who receives exports and has no account.
 */
const BOOKKEEPER_BACKED: readonly SeedKey[] = ["fees", "memberCharges"];

/**
 * Which seeded rows show people as they wrote themselves in, which the
 * register's masking of protected personal data cannot reach: a correspondent,
 * whoever uses the contact form, and whoever asks for an account are named by
 * what they sent, never by a register entry that could be masked.
 */
const NAMED_AS_WRITTEN: readonly SeedKey[] = [
  "contactSubmissions",
  "signupRequestsAndInvitations",
  "boardMailbox",
];

/**
 * Which seeded rows hand data to a program a member connected.
 *
 * The one processing whose whole purpose is handing data to something outside
 * the instance. Without a recipient list of its own it would be the row on the
 * record that named nobody, which is the opposite of what art. 30(1)(d) asks
 * for.
 */
const CLIENT_BACKED: readonly SeedKey[] = ["connectedApps"];

function storageRecipient(facts: ProcessorFacts, t: TFunction): string {
  if (facts.storageDriver !== "s3") {
    return t("dataProtection.processing.seed.recipients.localDisk");
  }
  return t("dataProtection.processing.seed.recipients.s3", {
    endpoint: facts.s3Endpoint ?? "",
    bucket: facts.s3Bucket ?? "",
  });
}

/**
 * The apps members have connected, named by where each is reached.
 *
 * The host of the client-id URL the app presented, or of the client URI it
 * registered - what says which app a board is reading about is where it lives,
 * and the whole address with its path would be longer and less recognisable. A
 * client the instance can read no host for is named by the name it declared,
 * because a recipient left out of the record is worse than one named awkwardly.
 *
 * Distinct, because one app connected by forty households is one recipient.
 */
function clientRecipients(facts: ProcessorFacts, t: TFunction): string {
  const named = [
    ...new Set(
      facts.connectedApps
        .map((app) => app.host ?? app.name)
        .filter((label): label is string => label !== null && label !== ""),
    ),
  ];
  return named.length === 0
    ? t("dataProtection.processing.seed.recipients.noConnectedApps")
    : named.join(", ");
}

function messageRecipients(facts: ProcessorFacts, t: TFunction): string {
  const parts: string[] = [];
  if (facts.smtpHost !== null && facts.smtpFromAddress !== null) {
    parts.push(facts.smtpHost);
  }
  if (facts.smsGatewayUrl !== null && facts.smsGatewayUrl.trim() !== "") {
    parts.push(facts.smsGatewayUrl);
  }
  return parts.length === 0
    ? t("dataProtection.processing.seed.recipients.noMailServer")
    : parts.join(", ");
}

/**
 * The mailbox the letters arrive in and stay in, and the mail server the
 * board's answers leave through.
 *
 * The answers only where the instance can send - the host and the sender both
 * set, the test {@link messageRecipients} and the processor list apply - since
 * a reply goes out through the instance's own SMTP identity. An instance with
 * no mailbox configured says so rather than naming nothing.
 */
function mailboxRecipients(facts: ProcessorFacts, t: TFunction): string {
  if (facts.mailbox === null) {
    return t("dataProtection.processing.seed.recipients.noMailbox");
  }
  const sentences = [
    t("dataProtection.processing.seed.recipients.mailbox", {
      host: facts.mailbox.host,
    }),
  ];
  if (facts.smtpHost !== null && facts.smtpFromAddress !== null) {
    sentences.push(
      t("dataProtection.processing.seed.recipients.replies", {
        host: facts.smtpHost,
      }),
    );
  }
  return sentences.join(" ");
}

/**
 * Everybody a row's data is handed to: one sentence per kind of recipient the
 * row has, in a fixed order, or null for a row that hands nothing on.
 */
function recipientsFor(
  key: SeedKey,
  facts: ProcessorFacts,
  t: TFunction,
): string | null {
  const sentences: string[] = [];
  if (MAILBOX_BACKED.includes(key)) {
    sentences.push(mailboxRecipients(facts, t));
  }
  if (MESSAGE_SENDING.includes(key)) {
    sentences.push(messageRecipients(facts, t));
  }
  if (CLIENT_BACKED.includes(key)) {
    sentences.push(clientRecipients(facts, t));
  }
  if (BOOKKEEPER_BACKED.includes(key)) {
    sentences.push(
      t("dataProtection.processing.seed.recipients.economicManager"),
    );
  }
  if (STORAGE_BACKED.includes(key)) {
    sentences.push(storageRecipient(facts, t));
  }
  return sentences.length === 0 ? null : sentences.join(" ");
}

/**
 * Whether the row's data leaves the instance to somewhere it cannot place.
 *
 * True for the storage-backed rows under the s3 driver, and deliberately
 * conservative: an object store the association does not run is data handed to
 * a host the instance has no way of locating, and a record that answered "no
 * transfer" by default would be asserting something nobody checked. The board
 * clears the flag once it has placed the bucket in the EU or EEA, or names the
 * art. 46 safeguard it relies on.
 *
 * True for the connected apps on the same reading, and as soon as there is one.
 * A client is a program the member runs, reached at an address the member's app
 * chose, on a machine the instance has even less of a way of locating than a
 * bucket. The board clears the flag for the apps its members use, or names the
 * safeguard.
 */
function transfersToThirdCountry(key: SeedKey, facts: ProcessorFacts): boolean {
  if (CLIENT_BACKED.includes(key)) {
    // Nothing is handed anywhere while nobody has connected anything, and a
    // transfer recorded against an empty list would be a false entry.
    return facts.connectedApps.length > 0;
  }
  return (
    STORAGE_BACKED.includes(key) &&
    facts.storageDriver === "s3" &&
    facts.s3Endpoint !== null
  );
}

/**
 * A general description of the art. 32(1) measures protecting one processing.
 *
 * Composed from the sentences that actually hold for the row rather than one
 * paragraph repeated on every row: art. 30(1)(g) asks what protects *this*
 * processing, and a record claiming field-level encryption for a table that has
 * none would be worse than one that said nothing.
 */
export function securityMeasuresFor(
  key: SeedKey,
  facts: ProcessorFacts,
  t: TFunction,
): string {
  const sentences = [
    t("dataProtection.processing.security.capabilityGates"),
    t("dataProtection.processing.security.auditLog"),
  ];

  if (
    SHAPES[key].personalDataCategories.some((category) =>
      ["email", "phone", "personalIdentityNumber"].includes(category),
    )
  ) {
    sentences.unshift(t("dataProtection.processing.security.encryptionAtRest"));
  }

  if (SHAPES[key].personalDataCategories.includes("name")) {
    /*
     * The masking of protected personal data reaches the people the register
     * names. Somebody who writes in is shown as they wrote, and saying they are
     * masked would be the claim this function exists not to make.
     */
    sentences.push(
      NAMED_AS_WRITTEN.includes(key)
        ? t("dataProtection.processing.security.namedAsWritten")
        : t("dataProtection.processing.security.protectedPersons"),
    );
  }

  if (STORAGE_BACKED.includes(key)) {
    sentences.push(
      facts.storageDriver === "s3"
        ? t("dataProtection.processing.security.s3", {
            endpoint: facts.s3Endpoint ?? "",
          })
        : t("dataProtection.processing.security.localDisk"),
    );
    // Only once it is true of every stored file (ADR 0015). The job at start
    // encrypts what an older instance stored, and until it has, the record
    // leaves the claim out rather than make it early.
    if (facts.unencryptedStoredFiles === 0) {
      sentences.push(t("dataProtection.processing.security.filesEncrypted"));
    }
  }

  return sentences.join(" ");
}

/**
 * The rows, translated into the association's own language and filled in from
 * what this instance is configured to do.
 *
 * @param t Bound to the association's default locale, not the reader's: the
 *   record is one document the board keeps, and a row that changed language
 *   depending on who opened the screen would not be one.
 * @param facts What the instance hands personal data to.
 */
export function seedRows(t: TFunction, facts: ProcessorFacts): SeedRow[] {
  return SEED_KEYS.map((key): SeedRow => {
    const shape = SHAPES[key];
    const recipients = recipientsFor(key, facts, t);
    const transfers = transfersToThirdCountry(key, facts);

    return {
      sourceKey: key,
      source: shape.source,
      name: t(`dataProtection.processing.seed.${key}.name`),
      purpose: t(`dataProtection.processing.seed.${key}.purpose`),
      legalBasis: shape.legalBasis,
      legalBasisNote: t(`dataProtection.processing.seed.${key}.legalBasisNote`),
      dataSubjectCategories: shape.dataSubjectCategories,
      personalDataCategories: shape.personalDataCategories,
      recipients,
      thirdCountryTransfer: transfers,
      thirdCountrySafeguards: !transfers
        ? null
        : CLIENT_BACKED.includes(key)
          ? t("dataProtection.processing.seed.clientTransfer", {
              // The same list the row names as its recipients: the sentence is
              // about where those apps run, so it has to say which they are.
              clients: recipients ?? "",
            })
          : t("dataProtection.processing.seed.storageTransfer", {
              endpoint: facts.s3Endpoint ?? "",
              bucket: facts.s3Bucket ?? "",
              region: facts.s3Region ?? "",
            }),
      retention: t(`dataProtection.processing.seed.${key}.retention`),
      securityMeasures: securityMeasuresFor(key, facts, t),
    };
  });
}
