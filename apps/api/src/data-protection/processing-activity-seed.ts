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
 * The sixteen keys below are fixed and asserted by the spec. Adding a table
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
  "residentDirectory",
  "newsMailings",
  "issues",
  "documents",
  "bookings",
  "events",
  "motions",
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
  motions: {
    source: "SERVICE_DATA",
    legalBasis: "CONTRACT",
    dataSubjectCategories: ["member"],
    personalDataCategories: ["name", "apartment", "freeText"],
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

function storageRecipient(facts: ProcessorFacts, t: TFunction): string {
  if (facts.storageDriver !== "s3") {
    return t("dataProtection.processing.seed.recipients.localDisk");
  }
  return t("dataProtection.processing.seed.recipients.s3", {
    endpoint: facts.s3Endpoint ?? "",
    bucket: facts.s3Bucket ?? "",
  });
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
 */
function transfersToThirdCountry(key: SeedKey, facts: ProcessorFacts): boolean {
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
 * paragraph repeated sixteen times: art. 30(1)(g) asks what protects *this*
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
 * The sixteen rows, translated into the association's own language and filled
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
      thirdCountrySafeguards: transfers
        ? t("dataProtection.processing.seed.storageTransfer", {
            endpoint: facts.s3Endpoint ?? "",
            bucket: facts.s3Bucket ?? "",
            region: facts.s3Region ?? "",
          })
        : null,
      retention: t(`dataProtection.processing.seed.${key}.retention`),
      securityMeasures: securityMeasuresFor(key, facts, t),
    };
  });
}
