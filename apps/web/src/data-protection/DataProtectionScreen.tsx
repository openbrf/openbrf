import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";

export interface DataProtectionScreenProps {
  viewer: Viewer;
}

/**
 * The association's own data protection records (dataskydd), as the board keeps
 * them.
 *
 * One capability across the whole screen, like the meetings screen and unlike
 * events or motions: the breach register, the record of processing activities,
 * the classification of every recipient of personal data and the overview of
 * what people have asked about their own data are one office doing one job -
 * showing that the association processes lawfully, GDPR art. 5(2) - and
 * `dataProtection:manage` gates all of it.
 *
 * There is no resident's own view here, deliberately. What a person holds about
 * their own data is exercised in two other places: the export of what they gave
 * the association, on their own profile (art. 20), and a request they make,
 * which the board records on their page in the register, because deciding it is
 * an act about one named person rather than about the association.
 *
 * Hiding the screen from an account that does not hold the capability is
 * courtesy only. The API refuses every call on it either way.
 */
export function DataProtectionScreen({
  viewer,
}: DataProtectionScreenProps): ReactElement | null {
  const { t } = useTranslation();

  if (!viewer.capabilities.includes("dataProtection:manage")) {
    return null;
  }

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-title">{t("dataProtection.title")}</h1>
        <p className="text-body text-ink-muted">{t("dataProtection.intro")}</p>
      </header>
    </section>
  );
}
