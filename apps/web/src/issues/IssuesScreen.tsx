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
  fetchOwnApartments,
  fetchOwnIssues,
  fetchReportableTypes,
  type IssueApartment,
  type OwnIssue,
  type ReportableIssueType,
} from "../api/issues";
import { LoadFailure } from "../ui/LoadFailure";
import { OwnIssuesPanel } from "./OwnIssuesPanel";
import { ReportIssuePanel } from "./ReportIssuePanel";

export interface IssuesScreenProps {
  viewer: Viewer;
}

/** Everything one load produces, applied to the screen in one step. */
interface Loaded {
  ready: boolean;
  types: readonly ReportableIssueType[];
  apartments: readonly IssueApartment[];
  own: readonly OwnIssue[];
  loadFailed: boolean;
}

const EMPTY: Loaded = {
  ready: false,
  types: [],
  apartments: [],
  own: [],
  loadFailed: false,
};

/**
 * Reporting an issue, and following one's own.
 *
 * The house's page, for whoever lives here and holds issues:report. The list
 * those reports arrive in is the board's page at /board/issues (ADR 0049), so
 * nothing here is shown to the board that a resident is not shown too.
 *
 * Hiding a panel is courtesy only. The API refuses the calls either way, and
 * the type list a reporter is offered is filtered by the server rather than
 * here.
 */
export function IssuesScreen({ viewer }: IssuesScreenProps): ReactElement {
  const { t } = useTranslation();

  const canReport = viewer.capabilities.includes("issues:report");

  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const currentRead = useRef(0);

  const read = useCallback(async (): Promise<Loaded> => {
    const [types, apartments, own] = await Promise.all([
      canReport ? fetchReportableTypes() : null,
      canReport ? fetchOwnApartments() : null,
      canReport ? fetchOwnIssues() : null,
    ]);

    return {
      ready: true,
      types: types?.ok === true ? types.value : [],
      apartments: apartments?.ok === true ? apartments.value : [],
      own: own?.ok === true ? own.value : [],
      loadFailed:
        types?.ok === false || apartments?.ok === false || own?.ok === false,
    };
  }, [canReport]);

  /**
   * Reads, and applies the answer only while it is still the newest one.
   *
   * One rule for the first read and every re-read, on the precedent
   * `MotionsScreen` sets. It matters more now than it did: the failure notice
   * offers a retry, so two reads in flight is a board pressing a button twice
   * rather than a race nobody could reach, and an older failure landing after a
   * newer success would put the screen back into the state the reader had just
   * got out of.
   */
  const reload = useCallback((): void => {
    const version = ++currentRead.current;
    void read().then((next) => {
      if (version === currentRead.current) {
        setLoaded(next);
      }
    });
  }, [read]);

  useEffect(() => {
    reload();
    /*
     * Leaving supersedes whatever is in flight, so a response that arrives
     * after the screen is gone is dropped by the same check that drops a
     * superseded one. One rule for both.
     */
    return () => {
      currentRead.current += 1;
    };
  }, [reload]);

  const { ready, types, apartments, own, loadFailed } = loaded;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("issues.title")}</h1>
        <p className="text-body text-ink-muted">{t("issues.intro")}</p>
      </header>

      {loadFailed ? (
        <LoadFailure messageKey="issues.loadFailed" onRetry={reload} />
      ) : null}

      {ready ? null : (
        <p role="status" className="text-body text-ink-muted">
          {t("issues.loading")}
        </p>
      )}

      {ready && canReport ? (
        <>
          <ReportIssuePanel
            types={types}
            apartments={apartments}
            onReported={reload}
          />
          <OwnIssuesPanel issues={own} />
        </>
      ) : null}
    </div>
  );
}
