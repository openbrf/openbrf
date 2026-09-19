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
 *   - Fixed text (name, purpose, legal basis, categories, retention). Written
 *     once at first seed in the association's own language, then left alone.
 *   - Fact-derived (recipients, third-country transfer and its safeguards, the
 *     security measures). Refreshed from the instance's settings on every seed,
 *     but only while `updatedByPersonId` is null - a changed storage driver
 *     should show up in the record, and a board's own wording should never be
 *     overwritten by a background job.
 *   - The board's own (a BOARD row, or any field it has edited). Never touched.
 *
 * The eighteen keys below are fixed and asserted by the spec. Adding a table
 * that holds personal data means adding a row here: that is the point of a
 * checked list rather than a derivation, and a processing the record does not
 * mention is the failure art. 30 exists to prevent.
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
 * The order is the order the record reads in: the statutory registers first,
 * because they are what the association exists to keep and what it may never
 * erase, then the service data in the order a resident meets it.
 */
export const SEED_KEYS = [
  "memberRegister",
  "apartmentRegister",
  "cooperativeHousingRegisterReporting",
  "meetingRecords",
  "auditLog",
  "addressBookAndAccounts",
  "connectedApps",
  "residentDirectory",
  "newsMailings",
  "issues",
  "documents",
  "bookings",
  "events",
  "motions",
  "chat",
  "fees",
  "websitePublication",
  "contactSubmissions",
  "signupRequestsAndInvitations",
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
  motions: {
    source: "SERVICE_DATA",
    legalBasis: "CONTRACT",
    dataSubjectCategories: ["member"],
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
     */
    dataSubjectCategories: ["member", "resident", "boardMember"],
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
};

/** Which seeded rows store files, and so name the storage recipient. */
const STORAGE_BACKED: readonly SeedKey[] = [
  "issues",
  "documents",
  "websitePublication",
];

/** Which seeded rows send a person a message, and so name mail and SMS. */
const MESSAGE_SENDING: readonly SeedKey[] = ["newsMailings"];

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
 * paragraph repeated eighteen times: art. 30(1)(g) asks what protects *this*
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
    sentences.push(t("dataProtection.processing.security.protectedPersons"));
  }

  if (STORAGE_BACKED.includes(key)) {
    sentences.push(
      facts.storageDriver === "s3"
        ? t("dataProtection.processing.security.s3", {
            endpoint: facts.s3Endpoint ?? "",
          })
        : t("dataProtection.processing.security.localDisk"),
    );
  }

  return sentences.join(" ");
}

/**
 * The eighteen rows, translated into the association's own language and filled
 * in from what this instance is configured to do.
 *
 * @param t Bound to the association's default locale, not the reader's: the
 *   record is one document the board keeps, and a row that changed language
 *   depending on who opened the screen would not be one.
 * @param facts What the instance hands personal data to.
 */
export function seedRows(t: TFunction, facts: ProcessorFacts): SeedRow[] {
  return SEED_KEYS.map((key): SeedRow => {
    const shape = SHAPES[key];
    const recipients = STORAGE_BACKED.includes(key)
      ? storageRecipient(facts, t)
      : MESSAGE_SENDING.includes(key)
        ? messageRecipients(facts, t)
        : CLIENT_BACKED.includes(key)
          ? clientRecipients(facts, t)
          : null;
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
