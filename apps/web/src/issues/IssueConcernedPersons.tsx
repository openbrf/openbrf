import { ISSUE_CONCERNED_PERSON_LIMIT } from "@openbrf/shared";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ApiFailure, ApiResult } from "../api/client";
import {
  addIssueConcernedPerson,
  fetchIssueConcernedPersons,
  type IssueConcernedPerson,
  type QueuedIssue,
  redactIssue,
} from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import { HINT, SECONDARY_BUTTON } from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import { TwoPressConfirm } from "../ui/TwoPressConfirm";
import { IssueResidentPicker, type ResidentPick } from "./IssueResidentPicker";

const FAILURES: Readonly<Record<string, TranslationKey>> = {
  "resident-not-found": "issues.concerned.errors.residentNotFound",
  "too-many-concerned-persons": "issues.concerned.errors.limit",
  "legal-hold": "issues.redaction.errors.legalHold",
  "redaction-target-not-found": "issues.concerned.errors.alreadyRemoved",
  "issue-not-found": "issues.handling.errors.issueNotFound",
  "invalid-body": "issues.concerned.errors.unknown",
};

/**
 * The refusals after which what is on screen is out of date: what was to be
 * removed is gone, a hold stands that the screen did not show, the issue is
 * gone, or the issue already names as many as it may. The list is read again,
 * and so is the issue, as the refusal's words say: a hold placed on the issue
 * since it was read is on the issue's own row, which the list does not carry,
 * and only the issue read again stops offering a removal.
 */
const STALE_REASONS: ReadonlySet<string> = new Set([
  "legal-hold",
  "redaction-target-not-found",
  "issue-not-found",
  "too-many-concerned-persons",
]);

/** One act on the list, so the two share one save in flight. */
type Act =
  { kind: "add"; residencyId: string } | { kind: "remove"; id: string };

function perform(issueId: string, act: Act): Promise<ApiResult<unknown>> {
  return act.kind === "add"
    ? addIssueConcernedPerson({ issueId, residencyId: act.residencyId })
    : redactIssue({
        issueId,
        redaction: { target: "concernedPerson", id: act.id },
      });
}

const NO_PICK: ResidentPick = { apartmentId: "", residencyId: "" };

/**
 * Whom an issue concerns (berörd person, ADR 0057): the residents a handler
 * records as the ones it is about when they are not recorded as its reporter,
 * such as the neighbour a report of a disturbance names. On an issue of any
 * type.
 *
 * A resident is picked as on an issue a handler opens, the apartment first and
 * then who lives there today (`IssueResidentPicker`), so the property manager
 * learns no more of the register than a door would tell them, and a protected
 * resident is listed as protected, never by name. Taking one off is a removal
 * as of the issue's text, asked twice: the record is part of the issue's free
 * text, goes with it, and is kept by what keeps it. While a legal hold stands
 * on the issue nobody is offered for removal; a hold or a restriction on its
 * reporter or on a person it concerns, which a handler is not shown, is the
 * server's refusal, said in the words a removal of text gets.
 *
 * One write at a time, adding and removing alike. The list is read when the
 * section opens and after every answer; a read that a newer one has overtaken
 * is dropped when it lands, so a slow answer cannot put back a person just
 * removed. It is read again too when the queue hands over a newer read of the
 * issue, so a name never outlives the protection placed on its resident, and
 * a failed read offers a retry. A refusal says what was refused until the handler picks again or
 * asks again.
 */
export function IssueConcernedPersonsSection({
  issue,
  onChanged,
}: {
  issue: QueuedIssue;
  /**
   * After an answer that wrote, and after a refusal that shows the screen out
   * of date: the timeline and the queue read again.
   */
  onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [list, setList] = useState<
    IssueConcernedPerson[] | "loading" | "failed"
  >("loading");
  const [reads, setReads] = useState(0);
  const [pick, setPick] = useState<ResidentPick>(NO_PICK);
  /** Which record's removal is being asked about, or null. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /*
   * Counts every read asked: a read lands only if no newer one has been asked
   * since it was sent.
   */
  const newest = useRef(0);
  /** Set once a failed read has been asked again, so a second failure takes focus. */
  const [retried, setRetried] = useState(false);

  /*
   * Read again whenever the queue hands over a newer read of the issue, and
   * not only when the issue changes: a resident marked protected since the
   * list was read is listed as protected on the next read, and a name kept on
   * screen from before would tell a handler what the instance withholds.
   */
  useEffect(() => {
    const version = ++newest.current;
    void fetchIssueConcernedPersons(issue.id).then((answer) => {
      if (version === newest.current) {
        setList(answer.ok ? answer.value : "failed");
      }
    });
  }, [issue, reads]);

  const save = useSaveAction(
    (act: Act) => perform(issue.id, act),
    () => {
      setConfirming(null);
      /*
       * Neither answer is put on screen: an addition's answer is the list as
       * it stood when it was written, and one that arrives after a newer read
       * would put back a name that read withheld. The list is read again, and
       * that read is the one that counts.
       */
      setPick(NO_PICK);
      setReads((count) => count + 1);
      onChanged();
    },
    (failure: ApiFailure) => {
      setConfirming(null);
      if (STALE_REASONS.has(failure.reason)) {
        setReads((count) => count + 1);
        onChanged();
      }
    },
  );
  const busy = save.pending;
  const failed = save.state.kind === "failed" ? save.state.failure : null;
  const clearFailure = (): void => {
    if (save.state.kind === "failed") {
      save.reset();
    }
  };

  const persons = Array.isArray(list) ? list : [];
  const full = persons.length >= ISSUE_CONCERNED_PERSON_LIMIT;
  const removable = issue.legalHoldAt === null;
  const nameOf = (person: IssueConcernedPerson): string =>
    person.kind === "person" ? person.name : t("issues.concerned.protected");

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-label text-ink-muted uppercase">
        {t("issues.concerned.title")}
      </h3>
      <p className={HINT}>{t("issues.concerned.intro")}</p>

      {failed === null ? null : (
        <Notice tone="danger" live>
          {t(
            failureMessageKey(
              failed,
              FAILURES,
              "issues.concerned.errors.unknown",
            ),
          )}
        </Notice>
      )}

      {list === "loading" ? (
        <p role="status" className={HINT}>
          {t("issues.concerned.loading")}
        </p>
      ) : list === "failed" ? (
        <LoadFailure
          messageKey="issues.concerned.readFailed"
          focusRetry={retried}
          onRetry={() => {
            setRetried(true);
            setList("loading");
            setReads((count) => count + 1);
          }}
        />
      ) : persons.length === 0 ? (
        <p className="text-small">{t("issues.concerned.none")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {persons.map((person) => (
            <li
              key={person.id}
              className="flex flex-wrap items-center gap-3 text-small"
            >
              <span>{nameOf(person)}</span>
              {removable ? (
                <span className="flex flex-col gap-1">
                  <TwoPressConfirm
                    confirming={confirming === person.id}
                    busy={busy}
                    askText={t("issues.redaction.remove")}
                    askLabel={t("issues.concerned.removeNamed", {
                      name: nameOf(person),
                    })}
                    confirmText={
                      busy
                        ? t("issues.redaction.removing")
                        : t("issues.redaction.confirm")
                    }
                    keepText={t("issues.redaction.keep")}
                    onAsk={() => {
                      clearFailure();
                      setConfirming(person.id);
                    }}
                    onConfirm={() => {
                      if (!busy) {
                        void save.submit({ kind: "remove", id: person.id });
                      }
                    }}
                    onKeep={() => {
                      setConfirming(null);
                    }}
                  />
                  {confirming === person.id ? (
                    <span className={HINT}>
                      {t("issues.concerned.removeHint")}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {removable || persons.length === 0 ? null : (
        <p className={HINT}>{t("issues.concerned.heldNotice")}</p>
      )}

      {list === "failed" ? null : full ? (
        <p className={HINT}>
          {t("issues.concerned.limit", {
            limit: ISSUE_CONCERNED_PERSON_LIMIT,
          })}
        </p>
      ) : (
        <form
          className="flex flex-col gap-2"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && pick.residencyId !== "") {
              void save.submit({ kind: "add", residencyId: pick.residencyId });
            }
          }}
        >
          {/* Nothing to change while an act is in flight: its answer clears
            the pick, and would clear one made meanwhile. */}
          <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0">
            <IssueResidentPicker
              purpose="concerned"
              pick={pick}
              onPick={(next) => {
                // A refusal is about the resident that was sent.
                clearFailure();
                setPick(next);
              }}
            />
          </fieldset>
          <div>
            <button
              type="submit"
              disabled={busy || pick.residencyId === ""}
              aria-label={t("issues.concerned.addNamed", {
                type: issue.typeName,
              })}
              className={SECONDARY_BUTTON}
            >
              {busy ? t("issues.concerned.adding") : t("issues.concerned.add")}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
