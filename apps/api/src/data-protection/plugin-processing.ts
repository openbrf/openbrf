import type {
  PluginDataSubject,
  PluginLegalBasis,
  PluginProcessing,
} from "@openbrf/plugin-sdk";
import type { DataSubjectCategory } from "@openbrf/shared";

import type { LegalBasis } from "../generated/prisma/enums";

/**
 * A plugin's processing declaration as the fields of its row in the record of
 * processing activities (ADR 0035).
 *
 * Pure, and its own file, so the mapping from the manifest's words to the
 * record's is stated once and can be read without the service that writes it.
 */

const LEGAL_BASIS: Record<PluginLegalBasis, LegalBasis> = {
  consent: "CONSENT",
  contract: "CONTRACT",
  legalObligation: "LEGAL_OBLIGATION",
  legitimateInterest: "LEGITIMATE_INTEREST",
};

const DATA_SUBJECT: Record<PluginDataSubject, DataSubjectCategory> = {
  members: "member",
  residents: "resident",
};

export interface DeclaredProcessingFields {
  purpose: string;
  legalBasis: LegalBasis;
  legalBasisNote: string | null;
  retention: string;
  dataSubjectCategories: DataSubjectCategory[];
}

/**
 * The row's fields, in the association's own language.
 *
 * One language and not the reader's, for the reason the seeded rows give: the
 * record is one document the board keeps. Anything but English reads as
 * Swedish, the product's first language and the default locale.
 */
export function declaredProcessing(
  processing: PluginProcessing,
  locale: string | null | undefined,
): DeclaredProcessingFields {
  const language = locale?.trim().toLowerCase().startsWith("en") ? "en" : "sv";
  return {
    purpose: processing.purpose[language],
    legalBasis: LEGAL_BASIS[processing.legalBasis],
    // The interest relied on is what art. 13(1)(d) puts on the notice, and the
    // note is where the record keeps it for every other row.
    legalBasisNote: processing.legitimateInterest?.[language] ?? null,
    retention: processing.retention[language],
    dataSubjectCategories: processing.dataSubjects.map(
      (subject) => DATA_SUBJECT[subject],
    ),
  };
}
