import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import {
  fetchBreaches,
  fetchDataProtectionOverview,
  fetchPrivacyNoticeCoverage,
  fetchProcessingRecord,
  fetchProcessors,
  type BreachView,
  type DataProtectionOverview,
  type PrivacyNoticeCoverage,
  type ProcessingRecord,
  type ProcessorView,
} from "../api/data-protection";
import { Notice } from "../ui/Notice";
import { BreachRegisterPanel } from "./BreachRegisterPanel";
import { OverviewStrip } from "./OverviewStrip";
import { PrivacyNoticeCoveragePanel } from "./PrivacyNoticeCoveragePanel";
import { ProcessingActivitiesPanel } from "./ProcessingActivitiesPanel";
import { ProcessorAgreementsPanel } from "./ProcessorAgreementsPanel";

export interface DataProtectionScreenProps {
  viewer: Viewer;
}

interface ScreenData {
  /** When these five answers were read, so the strip can say what was true. */
  readAt: Date;
  overview: DataProtectionOverview;
  breaches: BreachView[];
  record: ProcessingRecord;
  processors: ProcessorView[];
  coverage: PrivacyNoticeCoverage;
}

/**
 * The association's own data protection records (dataskydd), as the board keeps
 * them.
 *
 * One capability across the whole screen, like the meetings screen and unlike
 * events or motions: the breach register, the record of processing activities,
 * the classification of every recipient and the state of the privacy notice are
 * one office doing one job - showing that the association processes lawfully,
 * GDPR art. 5(2).
 *
 * There is no resident's own view here, deliberately. What a person holds about
 * their own data is exercised in two other places: the export of what they gave
 * the association, on their own profile (art. 20), and a request they make,
 * which the board records on their page in the register - because deciding it is
 * an act about one named person rather than about the association.
 *
 * Hiding the screen from an account without the capability is courtesy only.
 * The API refuses every call on it either way.
 *
 * ## Why every act re-reads
 *
 * Each of these panels changes what another one counts: classifying a recipient
 * moves the overview's tally, appending headings moves the notice's coverage,
 * deciding a breach empties the strip's first sentence. A screen that folded a
 * write's answer into its own state would show a set of numbers that never held
 * together at any single moment.
 */
export function DataProtectionScreen({
  viewer,
}: DataProtectionScreenProps): ReactElement | null {
  const { t } = useTranslation();
  const [data, setData] = useState<ScreenData | null>(null);
  const [failed, setFailed] = useState(false);

  const mayManage = viewer.capabilities.includes("dataProtection:manage");

  /** The newest read wins, so a slow first answer cannot overwrite a newer. */
  const generation = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    if (!mayManage) {
      return;
    }
    const mine = ++generation.current;

    const [overview, breaches, record, processors, coverage] =
      await Promise.all([
        fetchDataProtectionOverview(),
        fetchBreaches(),
        fetchProcessingRecord(),
        fetchProcessors(),
        fetchPrivacyNoticeCoverage(),
      ]);

    if (mine !== generation.current) {
      return;
    }

    if (
      !overview.ok ||
      !breaches.ok ||
      !record.ok ||
      !processors.ok ||
      !coverage.ok
    ) {
      setFailed(true);
      return;
    }

    setFailed(false);
    setData({
      readAt: new Date(),
      overview: overview.value,
      breaches: breaches.value,
      record: record.value,
      processors: processors.value,
      coverage: coverage.value,
    });
  }, [mayManage]);

  useEffect(() => {
    /*
     * The load is asynchronous throughout, so nothing here sets state during
     * the effect itself: every setState below happens after an awaited answer,
     * which is the render this screen is synchronising with.
     */
    const run = async (): Promise<void> => {
      await load();
    };
    void run();
  }, [load]);

  if (!mayManage) {
    return null;
  }

  return (
    <section className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-title">{t("dataProtection.title")}</h1>
        <p className="text-body text-ink-muted">{t("dataProtection.intro")}</p>
      </header>

      {failed ? (
        <Notice tone="danger" live>
          {t("dataProtection.loadFailed")}
        </Notice>
      ) : data === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("dataProtection.loading")}
        </p>
      ) : (
        <>
          <OverviewStrip overview={data.overview} readAt={data.readAt} />
          <BreachRegisterPanel
            breaches={data.breaches}
            onDecided={() => {
              void load();
            }}
          />
          <ProcessingActivitiesPanel record={data.record} />
          <ProcessorAgreementsPanel
            processors={data.processors}
            onRecorded={() => {
              void load();
            }}
          />
          <PrivacyNoticeCoveragePanel
            coverage={data.coverage}
            onAppended={() => {
              void load();
            }}
          />
        </>
      )}
    </section>
  );
}
