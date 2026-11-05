import {
  ISSUE_PRIORITIES,
  ISSUE_QUEUE_VIEWS,
  ISSUE_SEARCH_LIMITS,
  type IssuePriority,
  type IssueQueueView,
} from "@openbrf/shared";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import {
  fetchHandlerIssueTypes,
  fetchIssuePlaceCounts,
  fetchIssueQueueSnapshot,
  type IssuePlaceCount,
  type IssueQueueCounts,
  type IssueQueueFilter,
  type IssueTypeView,
  type QueuedIssue,
} from "../api/issues";
import { SEARCH_DELAY_MS } from "../feed/feed-limits";
import type { TranslationKey } from "../i18n/translation-key";
import { BoardPage } from "../ui/BoardPage";
import { FIELD, LABEL, QUIET_BUTTON } from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { ISSUE_MEANING_LABEL, ISSUE_PRIORITY_LABEL } from "./issue-labels";
import {
  DEFAULT_VIEW,
  meaningFilterOf,
  STATUS_CHOICES,
  type StatusChoice,
  VIEW_COUNT,
  VIEW_EMPTY,
  VIEW_LABEL,
  VIEW_PARAM,
} from "./issue-queue-views";
import { IssuePlaceCountsPanel } from "./IssuePlaceCountsPanel";
import { IssueQueuePanel } from "./IssueQueuePanel";
import { OpenIssuePanel } from "./OpenIssuePanel";

export interface IssueQueueScreenProps {
  viewer: Viewer;
  /** The view the address names; the handler's own work when it names none. */
  view?: IssueQueueView | null;
}

/** The filter as the handler set it, before it becomes the server's. */
interface Filter {
  status: StatusChoice;
  /** A type's identifier, or empty for every type. */
  typeId: string;
  /**
   * A common-area place's identifier (decision 30), or empty for the whole
   * queue. Chosen on the place's row of the counts, not in the bar.
   */
  placeId: string;
  priority: IssuePriority | "";
}

const NO_FILTER: Filter = {
  status: "OPEN",
  typeId: "",
  placeId: "",
  priority: "",
};

/** Everything one read of the queue produces, applied in one step. */
interface Loaded {
  /**
   * The request this answers, so an answer to an earlier one is never read as
   * this one's.
   */
  key: string | null;
  /**
   * Which read under that request this answers (`readCount`), so the list is
   * marked busy while a save's or a retry's read is out as well, not only
   * while the view or the filter changes.
   */
  readCount: number;
  /**
   * The filter the counts answer, which is the request without its view: the
   * numbers stay on the views while the handler moves between them.
   */
  filterKey: string | null;
  queue: readonly QueuedIssue[];
  /**
   * How many issues each view holds under the same filter, read with the list
   * and at the same moment, or null when the read failed: the views are then
   * drawn without numbers rather than with numbers nobody read.
   */
  counts: IssueQueueCounts | null;
  loadFailed: boolean;
}

const EMPTY: Loaded = {
  key: null,
  readCount: -1,
  filterKey: null,
  queue: [],
  counts: null,
  loadFailed: false,
};

/**
 * The types with their statuses, which an issue is moved between and opened
 * under: undefined until they are first read, null when they could not be.
 * Read apart from the queue, so a slow answer here never holds the list and
 * its numbers back. A failure leaves the queue readable, and the panel says
 * that nothing can be moved.
 */
type Types = readonly IssueTypeView[] | null | undefined;

/**
 * What set off a read of the types: the reader arriving, a change on the queue
 * (a save, an issue opened, the queue's own retry), or the retry beside the
 * types' notice.
 */
type TypesAsk = "arrival" | "change" | "retry";

/** A read of the types to make, numbered so the same ask twice reads twice. */
interface TypesRequest {
  count: number;
  by: TypesAsk;
}

/** The types as they were last read, and what set that read off. */
interface TypesRead {
  types: Types;
  by: TypesAsk;
}

/**
 * The common-area places with how many issues name each: undefined until they
 * are first read, null when they could not be. Read apart from the queue, as
 * the types are, and not drawn when the read fails.
 */
type Places = readonly IssuePlaceCount[] | null | undefined;

/** The status filter's words for each choice. */
const STATUS_CHOICE_LABEL: Readonly<Record<StatusChoice, TranslationKey>> = {
  OPEN: "issues.filter.statusOpen",
  ANY: "issues.filter.statusAny",
  ...ISSUE_MEANING_LABEL,
};

/**
 * "Handle issues": the queue the residents' reports arrive in, as a page of
 * its own under /board.
 *
 * Shared by the board and the external property manager, who holds
 * issues:handle and nothing else - for them this page is the whole of the
 * board's section - so it is signed for both rather than "Board" alone.
 * Reporting an issue and following one's own stay on the house's page.
 *
 * Four views (decision 15): Mina, the issues given to the reader; Ej
 * tilldelade, those given to nobody; Försenade, those past their target date;
 * and Alla. Each is a link, so the board's front page leads to one and the back
 * button walks them. Each carries how many issues it holds under the filter
 * below it, counted by the server under the conditions the list is read by
 * and in the same read, so the number and the list agree. The filter -
 * status, type, priority and a search - narrows every view alike and opens on
 * the open issues, so each view starts as the work still to do. The search is
 * asked of the server, which matches only what the reader may read: a
 * protected reporter's name and apartment match nothing. Above the views, the
 * common-area places with their counts (decision 30): choosing one narrows
 * every view to it, as the filter does, and clearing the filter leaves it.
 *
 * Hiding the queue is courtesy only. The API refuses the read either way.
 */
export function IssueQueueScreen({
  viewer,
  view: named,
}: IssueQueueScreenProps): ReactElement {
  const { t } = useTranslation();
  const view = named ?? DEFAULT_VIEW;

  const canHandle = viewer.capabilities.includes("issues:handle");

  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  /*
   * Only a read the reader set off from this screen, rather than the first,
   * makes its failure news, which is announced; and only a failed retry of the
   * types gives the focus to the retry on its new notice.
   */
  const [typesRead, setTypesRead] = useState<TypesRead>({
    types: undefined,
    by: "arrival",
  });
  const { types } = typesRead;
  /*
   * Bumped to read the types again: with the queue after a change on it, or
   * alone on the retry beside the types' notice, so a queue already on screen
   * is not read again for that, and not replaced by a failure notice if that
   * read would fail. Not for a change of view or filter.
   */
  const [typesRequest, setTypesRequest] = useState<TypesRequest>({
    count: 0,
    by: "arrival",
  });
  const [places, setPlaces] = useState<Places>(undefined);
  /*
   * Bumped to read the queue again under whatever view and filter are current
   * then: a save, an issue opened or a retry asks for it. A save started under
   * an earlier view finishes into this one, so it has no request of its own to
   * hold on to.
   */
  const [readCount, setReadCount] = useState(0);
  const reload = useCallback((): void => {
    setReadCount((count) => count + 1);
    setTypesRequest(({ count }) => ({ count: count + 1, by: "change" }));
  }, []);
  const retryTypes = useCallback((): void => {
    /*
     * Their notice goes while the retry is out, so a retry that fails too puts
     * a new one on screen, which is announced, rather than leaving the old one
     * standing as if nothing had been tried. The button pressed goes with it,
     * so the new notice's retry takes the focus back. Only offered while the
     * types are null, so no status form or draft goes with it.
     */
    setTypesRead({ types: undefined, by: "retry" });
    setTypesRequest(({ count }) => ({ count: count + 1, by: "retry" }));
  }, []);

  /*
   * The search is asked once the handler stops typing, rather than once per
   * letter on the way to the word they meant, as the feed's is.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(typed.trim());
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [typed]);

  const narrowing: IssueQueueFilter = {
    ...(meaningFilterOf(filter.status) === undefined
      ? {}
      : { meaning: meaningFilterOf(filter.status) }),
    ...(filter.typeId === "" ? {} : { typeId: filter.typeId }),
    ...(filter.placeId === "" ? {} : { placeId: filter.placeId }),
    ...(filter.priority === "" ? {} : { priority: filter.priority }),
    ...(search === "" ? {} : { search }),
  };
  /*
   * One string for the request, so the read below runs again exactly when the
   * view or the filter changes, and an answer is matched to the request it
   * answers.
   */
  const filterKey = JSON.stringify(narrowing);
  const key = JSON.stringify({ view, filter: narrowing });

  /*
   * Reads, and applies the answer only while it is still the newest one, on
   * the precedent `MotionQueueScreen` sets: the filter changes while a read is
   * out, and a save or the failure notice asks for another. A newer read, or
   * leaving, runs the cleanup, which drops the answer to this one.
   */
  useEffect(() => {
    if (!canHandle) {
      return;
    }
    let current = true;
    const { view: asked, filter: counted } = JSON.parse(key) as {
      view: IssueQueueView;
      filter: IssueQueueFilter;
    };
    // The list and the numbers on the views are one answer, read by the
    // server at one moment.
    void fetchIssueQueueSnapshot({ view: asked, ...counted }).then(
      (snapshot) => {
        if (current) {
          setLoaded({
            key,
            readCount,
            filterKey: JSON.stringify(counted),
            queue: snapshot.ok ? snapshot.value.issues : [],
            counts: snapshot.ok ? snapshot.value.counts : null,
            loadFailed: !snapshot.ok,
          });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [canHandle, key, readCount]);

  /*
   * The types, read again whenever the queue is read again for a save, an
   * issue opened or a retry, and on their own retry, but not for each change
   * of view or filter. A status switched off since they were read is refused
   * by the server, and the panel reads the queue again on that refusal.
   */
  useEffect(() => {
    if (!canHandle) {
      return;
    }
    let current = true;
    const { by } = typesRequest;
    void fetchHandlerIssueTypes().then((read) => {
      if (!current) {
        return;
      }
      const next = read.ok ? read.value : null;
      /*
       * A failure that stands from an earlier read is not news, so it stays as
       * it was first put, announced or not, rather than its notice gaining the
       * alert role in place, which a screen reader need not announce.
       */
      setTypesRead((before) =>
        next === null && before.types === null ? before : { types: next, by },
      );
    });
    return () => {
      current = false;
    };
  }, [canHandle, typesRequest]);

  /*
   * The places' counts, read again with the queue after a save, an issue
   * opened or a retry, since any of those can move a count, and when a place
   * is chosen or left, so the row chosen from is current. Not for the other
   * changes of view or filter: they count every issue the reader may open.
   */
  useEffect(() => {
    if (!canHandle) {
      return;
    }
    let current = true;
    void fetchIssuePlaceCounts().then((read) => {
      if (current) {
        const listed = read.ok ? read.value : null;
        setPlaces(listed);
        /*
         * The control that leaves a place is on that place's row of the
         * counts. Without the counts, or with counts that no longer list the
         * place (switched off with nothing left on it, or removed), a queue
         * narrowed to it would be narrowed by something the screen no longer
         * shows. Clearing the place reads the queue again unnarrowed.
         */
        setFilter((now) =>
          now.placeId === "" ||
          (listed !== null && listed.some((place) => place.id === now.placeId))
            ? now
            : { ...now, placeId: "" },
        );
      }
    });
    return () => {
      current = false;
    };
  }, [canHandle, readCount, filter.placeId]);

  const ready = loaded.key !== null;
  // The list on screen answers an earlier filter, or an earlier read under
  // this one, until this read's answer lands.
  const reading = loaded.key !== key || loaded.readCount !== readCount;
  // Of those, the read a change on the queue asked for, which the rows'
  // status forms wait for (`IssueQueuePanel`'s `rereading`); the handling
  // under a row waits for every read (`reading`).
  const rereading = loaded.readCount !== readCount;
  const { queue, counts, loadFailed } = loaded;
  const narrowed =
    filter.status !== NO_FILTER.status ||
    filter.typeId !== "" ||
    filter.placeId !== "" ||
    filter.priority !== "" ||
    search !== "";

  return (
    <BoardPage
      title={t("issues.boardTitle")}
      audience="issueHandling"
      offered={canHandle}
    >
      {/*
       * Opening an issue needs the types and not the queue, so a queue that
       * could not be read leaves the form in place.
       */}
      {types === undefined || types === null ? null : (
        <OpenIssuePanel types={types} onOpened={reload} />
      )}

      {places === undefined || places === null ? null : (
        <IssuePlaceCountsPanel
          places={places}
          selected={filter.placeId}
          onSelect={(placeId) => {
            setFilter((current) => ({ ...current, placeId }));
          }}
        />
      )}

      <ViewNav
        view={view}
        counts={loaded.filterKey === filterKey ? counts : null}
      />

      {/*
       * A search landmark, so the filter is found by name and its "Status" is
       * not mistaken for a row's own status further down.
       */}
      <div
        role="search"
        aria-label={t("issues.filter.label")}
        className="flex flex-wrap items-end gap-3"
      >
        <label className={`${LABEL} min-w-48 flex-1`}>
          {t("issues.filter.search")}
          <input
            type="search"
            className={FIELD}
            value={typed}
            maxLength={ISSUE_SEARCH_LIMITS.length}
            onChange={(event) => {
              setTyped(event.target.value);
            }}
          />
        </label>
        <label className={`${LABEL} min-w-40`}>
          {t("issues.filter.status")}
          <select
            className={FIELD}
            value={filter.status}
            onChange={(event) => {
              setFilter({
                ...filter,
                status: event.target.value as StatusChoice,
              });
            }}
          >
            {STATUS_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {t(STATUS_CHOICE_LABEL[choice])}
              </option>
            ))}
          </select>
        </label>
        <label className={`${LABEL} min-w-40`}>
          {t("issues.filter.type")}
          <select
            className={FIELD}
            value={filter.typeId}
            onChange={(event) => {
              setFilter({ ...filter, typeId: event.target.value });
            }}
          >
            <option value="">{t("issues.filter.typeAny")}</option>
            {(types ?? []).map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </label>
        <label className={`${LABEL} min-w-40`}>
          {t("issues.filter.priority")}
          <select
            className={FIELD}
            value={filter.priority}
            onChange={(event) => {
              setFilter({
                ...filter,
                priority: event.target.value as IssuePriority | "",
              });
            }}
          >
            <option value="">{t("issues.filter.priorityAny")}</option>
            {ISSUE_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {t(ISSUE_PRIORITY_LABEL[priority])}
              </option>
            ))}
          </select>
        </label>
        {narrowed || typed !== "" ? (
          <button
            type="button"
            className={QUIET_BUTTON}
            onClick={() => {
              setFilter(NO_FILTER);
              setTyped("");
              setSearch("");
            }}
          >
            {t("issues.filter.clear")}
          </button>
        ) : null}
      </div>

      {loadFailed && !reading ? (
        <LoadFailure messageKey="issues.loadFailed" onRetry={reload} />
      ) : null}

      {reading ? (
        <p role="status" className="text-body text-ink-muted">
          {t("issues.loading")}
        </p>
      ) : null}

      {/*
       * The list is not drawn over a failed read: an empty queue says nothing
       * is waiting, which is a claim the notice above would not undo. The
       * panel stays mounted (`listWithheld`), because the status save it owns
       * may still be out, and its refusal is shown there. While a newer read
       * is out the earlier list stays, marked busy, rather than the page
       * jumping empty under each word typed into the search.
       */}
      {ready ? (
        <div aria-busy={reading} className={reading ? "opacity-60" : ""}>
          <IssueQueuePanel
            emptyMessage={
              narrowed ? t("issues.views.noMatch") : t(VIEW_EMPTY[view])
            }
            issues={queue}
            // No forms yet while the types are still on their way, and no
            // notice that they failed either.
            types={types === undefined ? [] : types}
            onChanged={reload}
            queueRead={loaded.readCount}
            onRetryTypes={retryTypes}
            announceTypesFailure={typesRead.by !== "arrival"}
            focusTypesRetry={typesRead.by === "retry"}
            rereading={rereading}
            reading={reading}
            listWithheld={loadFailed}
            canManageCharges={viewer.capabilities.includes(
              "memberCharges:manage",
            )}
          />
        </div>
      ) : null}
    </BoardPage>
  );
}

/**
 * The four views, as links with the one open marked: a shape as well as a
 * colour, the underline the settings' own navigation uses (DESIGN.md). Each
 * says how many issues it holds, in the mono grid, once they are counted.
 */
function ViewNav({
  view,
  counts,
}: {
  view: IssueQueueView;
  counts: IssueQueueCounts | null;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <nav aria-label={t("issues.views.label")} className="min-w-0">
      <ul className="flex overflow-x-auto border-b border-line">
        {ISSUE_QUEUE_VIEWS.map((each) => {
          const count = counts?.[VIEW_COUNT[each]];
          const current = each === view;
          return (
            <li key={each} className="shrink-0">
              <Link
                to="/board/issues"
                search={{ view: VIEW_PARAM[each] }}
                aria-current={current ? "page" : undefined}
                className={current ? VIEW_CURRENT : VIEW_AT_REST}
              >
                {t(VIEW_LABEL[each])}
                {count === undefined ? null : " "}
                {count === undefined ? null : (
                  <span
                    className={`font-data text-data ${each === "OVERDUE" && count > 0 ? "font-semibold text-danger" : ""}`}
                  >
                    {count}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/*
 * One view's link. min-h-11 is the 44px touch target; the open one is
 * underlined in the trust accent, as the settings' sections are, and brass
 * marks nothing else here.
 */
const VIEW_LINK =
  "flex min-h-11 items-center gap-2 border-b-[3px] px-3 text-body font-medium whitespace-nowrap transition-colors duration-(--obrf-motion-duration) ease-(--obrf-motion-easing)";
const VIEW_AT_REST = `${VIEW_LINK} border-transparent text-ink-muted hover:text-ink`;
const VIEW_CURRENT = `${VIEW_LINK} border-trust text-ink`;
