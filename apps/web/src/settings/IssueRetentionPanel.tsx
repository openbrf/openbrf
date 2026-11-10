import {
  ISSUE_TEXT_RETENTION_YEARS,
  RING_FENCED_ISSUE_TEXT_RETENTION_YEARS,
} from "@openbrf/shared";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import {
  fetchIssueRetention,
  type IssueRetention,
  saveIssueRetention,
} from "../api/issues";
import { FIELD_DATA, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

/** One finished read, and which read it answers for. */
interface Loaded {
  readonly read: number;
  readonly clocks: IssueRetention | null;
  readonly failed: boolean;
}

/** The two clocks as the board types them. */
type Draft = Record<keyof IssueRetention, string>;

/** The bounds of each clock, which the API refuses outside of as well. */
const BOUNDS: Record<
  keyof IssueRetention,
  { readonly min: number; readonly max: number }
> = {
  years: ISSUE_TEXT_RETENTION_YEARS,
  ringFencedYears: RING_FENCED_ISSUE_TEXT_RETENTION_YEARS,
};

/** The whole entry or nothing, as the retention policy reads its number. */
function parsedYears(typed: string): number {
  return typed.trim() === "" ? Number.NaN : Number(typed);
}

function inRange(years: number, clock: keyof IssueRetention): boolean {
  return (
    Number.isInteger(years) &&
    years >= BOUNDS[clock].min &&
    years <= BOUNDS[clock].max
  );
}

/**
 * How many years after an issue closes its free text is kept (ADR 0057,
 * decision 33): the board's clock, from one to ten years, two by default, and
 * beside it a ring-fenced type's own clock (decision 32), from one to ten
 * years, one by default. Both are saved together.
 *
 * The panel says what the number reaches and what it does not. The building
 * record - what, where, when and the outcome - stays with the issue; the
 * description, the location, the conversation, the notes and the files go,
 * unless a legal hold stands on the issue or a legal hold or a restriction
 * on its reporter. And it says that the purge reads
 * the number when it runs, so a board shortening it learns before saving that
 * the nights that follow remove what is already past the new clock, at most
 * 500 issues in each run.
 */
export function IssueRetentionPanel(): ReactElement {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reads, setReads] = useState(0);
  /** The board's entries, or null while it shows what was read. */
  const [draft, setDraft] = useState<Draft | null>(null);
  /** Counts the board's edits, so an answer can tell its entry was changed. */
  const edits = useRef(0);
  /** The edit count at the entry being saved. */
  const sent = useRef(0);

  useEffect(() => {
    let active = true;
    void fetchIssueRetention().then((result) => {
      if (!active) {
        return;
      }
      setLoaded((previous) => ({
        read: reads,
        clocks: result.ok ? result.value : (previous?.clocks ?? null),
        failed: !result.ok,
      }));
    });
    return () => {
      active = false;
    };
  }, [reads]);

  const save = useSaveAction(saveIssueRetention, (saved) => {
    setLoaded((previous) => ({
      read: previous?.read ?? reads,
      clocks: saved,
      failed: false,
    }));
    // The answer is about the number that was sent. An entry typed while it
    // was on its way stands, and nothing is said to have been saved for it.
    if (edits.current === sent.current) {
      setDraft(null);
    }
  });

  const stored = loaded?.clocks ?? null;
  const readFailed = loaded !== null && loaded.read === reads && loaded.failed;
  const typed: Draft = draft ?? {
    years: stored === null ? "" : String(stored.years),
    ringFencedYears: stored === null ? "" : String(stored.ringFencedYears),
  };
  const parsed: IssueRetention = {
    years: parsedYears(typed.years),
    ringFencedYears: parsedYears(typed.ringFencedYears),
  };
  const outOfRange = {
    years: !inRange(parsed.years, "years"),
    ringFencedYears: !inRange(parsed.ringFencedYears, "ringFencedYears"),
  };
  const anyOutOfRange = outOfRange.years || outOfRange.ringFencedYears;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (anyOutOfRange || save.pending) {
      return;
    }
    sent.current = edits.current;
    void save.submit(parsed);
  };

  const field = (
    clock: keyof IssueRetention,
    name: string,
    label: string,
    hint: string,
  ): ReactElement => (
    <label className={LABEL}>
      {label}
      <input
        type="number"
        name={name}
        min={BOUNDS[clock].min}
        max={BOUNDS[clock].max}
        step={1}
        value={typed[clock]}
        aria-invalid={outOfRange[clock] ? true : undefined}
        onChange={(event) => {
          edits.current += 1;
          const value = event.target.value;
          // The other clock's entry as it stands, typed or read.
          setDraft((previous) => ({ ...(previous ?? typed), [clock]: value }));
          // A refusal or a confirmation is about the numbers that were sent;
          // a new entry clears it, also while the answer is still on its
          // way, which then no longer sets either.
          if (save.state.kind !== "idle") {
            save.reset();
          }
        }}
        className={FIELD_DATA}
      />
      <span className={HINT}>{hint}</span>
    </label>
  );

  return (
    <Panel
      title={t("settings.issueRetention.title")}
      description={t("settings.issueRetention.description")}
      notice={
        <>
          <Notice tone="info">{t("settings.issueRetention.purgeJob")}</Notice>
          {save.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t(
                failureMessageKey(
                  save.state.failure,
                  { "invalid-body": "settings.issueRetention.errors.range" },
                  "settings.issueRetention.errors.unknown",
                ),
              )}
            </Notice>
          ) : save.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("settings.saved")}
            </Notice>
          ) : null}
        </>
      }
    >
      {readFailed ? (
        <LoadFailure
          messageKey="settings.issueRetention.loadFailed"
          onRetry={() => {
            setReads((count) => count + 1);
          }}
        />
      ) : null}
      {stored === null ? (
        readFailed ? null : (
          <p role="status" className={HINT}>
            {t("settings.issueRetention.loading")}
          </p>
        )
      ) : (
        <form className="flex flex-col gap-4" onSubmit={onSubmit}>
          {field(
            "years",
            "issueRetentionYears",
            t("settings.issueRetention.years"),
            t("settings.issueRetention.yearsHint"),
          )}
          {/* The ring-fenced clock is its own setting, never held to the one
              above in either direction (decision 32). */}
          <p className={HINT}>{t("settings.issueRetention.ringFenced")}</p>
          {field(
            "ringFencedYears",
            "issueRetentionRingFencedYears",
            t("settings.issueRetention.ringFencedYears"),
            t("settings.issueRetention.ringFencedYearsHint"),
          )}

          {anyOutOfRange ? (
            <Notice tone="warn" live>
              {t("settings.issueRetention.errors.range")}
            </Notice>
          ) : null}

          <div>
            <button
              type="submit"
              disabled={anyOutOfRange || save.pending}
              className={PRIMARY_BUTTON}
            >
              {save.pending ? t("settings.saving") : t("settings.save")}
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
}
