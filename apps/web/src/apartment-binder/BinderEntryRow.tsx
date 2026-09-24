import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { ApiResult } from "../api/client";
import { NotRecorded } from "../ui/NotRecorded";
import { Notice } from "../ui/Notice";
import { PANEL, QUIET_BUTTON } from "../ui/controls";
import { useSaveAction } from "../ui/save-state";
import type { BinderEntry, BinderFilerView } from "./apartment-binder-api";
import { binderFailureKey } from "./binder-failures";
import { AUDIENCE_LABEL, FILED_AS_LABEL, fileSizeOf } from "./binder-kinds";

/**
 * One entry in a binder: what it is, who it is for, and how to open it.
 *
 * The link points at the media route, which is where the file's own audience is
 * enforced against the residency. Nothing on this row decides access; the sign
 * beside the title says what was decided.
 *
 * Who filed it is a prop rather than a field of the entry, because a household
 * is not shown a name at all: the answer it reads carries none. One rule for
 * every household is simpler to keep true than a rule with an exception for
 * people who live together, and it is the rule that protects a tenant-owner
 * with protected personal data without a branch for them.
 */

/** Every entry carries this much, whoever is reading it. */
type Entry = Omit<BinderEntry, "filedByYou">;

export interface BinderEntryRowProps {
  entry: Entry;
  /**
   * Who filed it, where the reader is shown that. Omitted on a household's
   * screen, where nobody is named.
   */
  filedBy?: BinderFilerView;
  /** Whether the reader filed it themselves, which is what says "you". */
  mine?: boolean;
  /**
   * Takes the entry out, or null where this reader may not.
   *
   * Null rather than a disabled control: an act somebody is not offered is one
   * the screen should not put in front of them at all.
   */
  takeOut: (() => Promise<ApiResult<void>>) | null;
  /** Called once it is out, so the binder is read again. */
  onTakenOut: () => void;
}

export function BinderEntryRow({
  entry,
  filedBy,
  mine,
  takeOut,
  onTakenOut,
}: BinderEntryRowProps): ReactElement {
  const { t } = useTranslation();
  const size = fileSizeOf(entry.byteSize);

  const run = useCallback((): Promise<ApiResult<void>> => {
    if (takeOut === null) {
      // Not reachable: the control below is not rendered without one. Answered
      // rather than thrown, because a promise that rejects here would be a
      // second failure mode for a state that cannot happen.
      return Promise.resolve({ ok: true, value: undefined });
    }
    return takeOut();
  }, [takeOut]);
  const removal = useSaveAction(run, onTakenOut);

  return (
    <div className={`flex flex-col gap-3 ${PANEL}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <a
            href={entry.url}
            /*
             * A new context, because a drawing is read beside the binder rather
             * than instead of it - and rel is not optional on a target: without
             * it the opened view can reach back through window.opener.
             */
            target="_blank"
            rel="noreferrer"
            aria-label={t("apartmentBinder.entry.openFile", {
              title: entry.title,
            })}
            className="text-body font-semibold text-ink underline decoration-line-strong underline-offset-4"
          >
            {entry.title}
          </a>

          <span className="font-data text-small text-ink-muted">
            {t("apartmentBinder.entry.fileSummary", {
              fileName: entry.fileName,
              size: t(`apartmentBinder.size.${size.unit}`, {
                size: size.size,
              }),
            })}
          </span>

          {/*
           * The day on the entry, in the data face: a date is data, and the
           * mono grid is where dates are read down a column. An entry with no
           * day says so rather than leaving a gap, because a gap and a date
           * that failed to arrive look the same.
           */}
          <span className="font-data text-small text-ink-muted">
            {entry.datedOn === null ? (
              <NotRecorded meaning={t("apartmentBinder.entry.undated")} />
            ) : (
              t("apartmentBinder.entry.datedOn", { date: entry.datedOn })
            )}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Sign>{t(AUDIENCE_LABEL[entry.audience])}</Sign>
          <Sign>
            {mine === true
              ? t("apartmentBinder.filedAs.you")
              : t(FILED_AS_LABEL[entry.filedAs])}
          </Sign>

          {takeOut === null ? null : (
            <button
              type="button"
              disabled={removal.state.kind === "saving"}
              onClick={() => {
                // Confirmed because the bytes go with the row: nothing here
                // puts an entry back.
                if (
                  window.confirm(
                    t("apartmentBinder.takeOut.confirm", {
                      title: entry.title,
                    }),
                  )
                ) {
                  void removal.submit();
                }
              }}
              aria-label={t("apartmentBinder.takeOut.actionLabel", {
                title: entry.title,
              })}
              className={QUIET_BUTTON}
            >
              {removal.state.kind === "saving"
                ? t("apartmentBinder.takeOut.working")
                : t("apartmentBinder.takeOut.action")}
            </button>
          )}
        </div>
      </div>

      {filedBy === undefined ? null : (
        <p className="text-small text-ink-muted">
          <FiledBy who={filedBy} />
        </p>
      )}

      {/*
       * The refusal sits on the row whose control was pressed, and not at the
       * top of a screen that may be showing three binders: what failed here is
       * this entry's removal, and a sentence anywhere else would be about an
       * act the reader would have to go looking for.
       */}
      {removal.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(binderFailureKey(removal.state.failure))}
        </Notice>
      ) : null}
    </div>
  );
}

/** The chip that names something about an entry on the shelf. */
function Sign({ children }: { children: string }): ReactElement {
  return (
    <span className="inline-flex h-5.5 shrink-0 items-center rounded-control border border-line px-2 text-chip text-ink-muted uppercase">
      {children}
    </span>
  );
}

/**
 * Who filed an entry, as the board may be told.
 *
 * A person with protected personal data is named to nobody here, every board
 * member included: the capability that reveals such a field is what lets
 * somebody perform an act of revealing and be recorded doing it, and a name
 * appearing in a listing is not that act. A link the purge has detached says so
 * rather than showing an empty name.
 */
function FiledBy({ who }: { who: BinderFilerView }): ReactElement {
  const { t } = useTranslation();

  if (who.kind === "person") {
    return <>{t("apartmentBinder.board.filedBy", { name: who.name })}</>;
  }
  return (
    <>
      {t("apartmentBinder.board.filedBy", {
        name: t(
          who.kind === "protected"
            ? "apartmentBinder.board.filerProtected"
            : "apartmentBinder.board.filerUnknown",
        ),
      })}
    </>
  );
}
