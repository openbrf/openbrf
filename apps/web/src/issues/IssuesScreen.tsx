import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import {
  fetchIssueQueue,
  fetchOwnApartments,
  fetchOwnIssues,
  fetchReportableTypes,
  type IssueApartment,
  type OwnIssue,
  type QueuedIssue,
  type ReportableIssueType,
} from "../api/issues";
import { Notice } from "../ui/Notice";
import { IssueQueuePanel } from "./IssueQueuePanel";
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
  queue: readonly QueuedIssue[];
  loadFailed: boolean;
}

const EMPTY: Loaded = {
  ready: false,
  types: [],
  apartments: [],
  own: [],
  queue: [],
  loadFailed: false,
};

/**
 * Reporting an issue, following one's own, and - for whoever handles them - the
 * queue.
 *
 * What a viewer sees follows from their capabilities, and the two halves are
 * deliberately independent. A resident reports and follows. An external
 * property manager holds issues:handle and nothing else, so they get the queue
 * and no report form at all: they do not live in the building. A board member
 * holds both and gets both.
 *
 * Hiding a panel is courtesy only. The API refuses the calls either way, and
 * the type list a reporter is offered is filtered by the server rather than
 * here.
 */
export function IssuesScreen({ viewer }: IssuesScreenProps): ReactElement {
  const { t } = useTranslation();

  const canReport = viewer.capabilities.includes("issues:report");
  const canHandle = viewer.capabilities.includes("issues:handle");

  const [loaded, setLoaded] = useState<Loaded>(EMPTY);

  const read = useCallback(async (): Promise<Loaded> => {
    const [types, apartments, own, queue] = await Promise.all([
      canReport ? fetchReportableTypes() : null,
      canReport ? fetchOwnApartments() : null,
      canReport ? fetchOwnIssues() : null,
      canHandle ? fetchIssueQueue() : null,
    ]);

    return {
      ready: true,
      types: types?.ok === true ? types.value : [],
      apartments: apartments?.ok === true ? apartments.value : [],
      own: own?.ok === true ? own.value : [],
      queue: queue?.ok === true ? queue.value : [],
      loadFailed:
        types?.ok === false ||
        apartments?.ok === false ||
        own?.ok === false ||
        queue?.ok === false,
    };
  }, [canReport, canHandle]);

  useEffect(() => {
    // The effect owns its own call and drops a response that arrives after the
    // screen is gone, rather than applying it to a component nobody is looking
    // at.
    let active = true;
    void read().then((next) => {
      if (active) {
        setLoaded(next);
      }
    });
    return () => {
      active = false;
    };
  }, [read]);

  const reload = (): void => {
    void read().then(setLoaded);
  };

  const { ready, types, apartments, own, queue, loadFailed } = loaded;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("issues.title")}</h1>
        <p className="text-body text-ink-muted">{t("issues.intro")}</p>
      </header>

      {loadFailed ? (
        <Notice tone="danger" live>
          {t("issues.loadFailed")}
        </Notice>
      ) : null}

      {ready ? null : (
        <p role="status" className="text-body text-ink-muted">
          {t("issues.loading")}
        </p>
      )}

      {ready && canHandle ? (
        <IssueQueuePanel issues={queue} onChanged={reload} />
      ) : null}

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
