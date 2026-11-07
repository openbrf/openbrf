import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import {
  ISSUE_OUTCOME_LABEL,
  ISSUE_WAITING_REASON_LABEL,
} from "../issues/issue-labels";
import { Notice } from "../ui/Notice";
import { PendingChangeInput } from "./PendingChangeInput";
import type {
  InputName,
  PendingChangeTarget as Target,
  PendingChangeTargetFact,
} from "./pending-changes-api";

const KIND = {
  news: "pendingChanges.target.kind.news",
  page: "pendingChanges.target.kind.page",
  issue: "pendingChanges.target.kind.issue",
} as const satisfies Record<Target["kind"], TranslationKey>;

const MISSING = {
  news: "pendingChanges.target.missing.news",
  page: "pendingChanges.target.missing.page",
  issue: "pendingChanges.target.missing.issue",
} as const satisfies Record<Target["kind"], TranslationKey>;

/**
 * The facts the API names, by the words this screen has for them. Not total
 * over a string: a fact a later API adds is shown under its own name.
 */
const FACT: Readonly<Record<string, TranslationKey>> = {
  title: "pendingChanges.target.fact.title",
  slug: "pendingChanges.target.fact.slug",
  status: "pendingChanges.target.fact.status",
  visibility: "pendingChanges.target.fact.visibility",
  mailingRequested: "pendingChanges.target.fact.mailingRequested",
  frontPage: "pendingChanges.target.fact.frontPage",
  number: "pendingChanges.target.fact.number",
  type: "pendingChanges.target.fact.type",
  issueStatus: "pendingChanges.target.fact.issueStatus",
  waitingReason: "pendingChanges.target.fact.waitingReason",
  outcome: "pendingChanges.target.fact.outcome",
  priority: "pendingChanges.target.fact.priority",
  targetDate: "pendingChanges.target.fact.targetDate",
  assignee: "pendingChanges.target.fact.assignee",
};

/** The values of the facts that are a choice of a few, by fact. */
const VALUE: Readonly<
  Record<string, Readonly<Record<string, TranslationKey>>>
> = {
  status: {
    DRAFT: "pendingChanges.target.value.status.DRAFT",
    PUBLISHED: "pendingChanges.target.value.status.PUBLISHED",
    MEMBERS_ONLY: "pendingChanges.target.value.status.MEMBERS_ONLY",
    PUBLIC: "pendingChanges.target.value.status.PUBLIC",
  },
  visibility: {
    PUBLIC: "pendingChanges.target.value.visibility.PUBLIC",
    MEMBER: "pendingChanges.target.value.visibility.MEMBER",
  },
  priority: {
    URGENT: "pendingChanges.target.value.priority.URGENT",
    NORMAL: "pendingChanges.target.value.priority.NORMAL",
    LOW: "pendingChanges.target.value.priority.LOW",
  },
  waitingReason: ISSUE_WAITING_REASON_LABEL,
  outcome: ISSUE_OUTCOME_LABEL,
};

/**
 * The facts the API leaves empty when there is nothing, by the word for that:
 * an issue's target date, which is optional and never an empty day, the
 * waiting reason and outcome of an issue that is not waiting or not done, and
 * the assignee of an issue nobody has.
 */
const EMPTY: Readonly<Record<string, TranslationKey>> = {
  targetDate: "pendingChanges.target.value.noTargetDate",
  waitingReason: "pendingChanges.target.value.noWaitingReason",
  outcome: "pendingChanges.target.value.noOutcome",
  assignee: "pendingChanges.target.value.noAssignee",
};

/**
 * The facts that are a person's id, shown as the input preview shows one: with
 * the name the API gives for it beside it, or alone where it gives none.
 */
const PERSON_FACTS: ReadonlySet<string> = new Set(["assignee"]);

/** The facts that are register data, read character by character. */
const DATA_FACTS: ReadonlySet<string> = new Set([
  "slug",
  "number",
  "targetDate",
]);

/**
 * What a pending change is to: the news item, page or issue its input names
 * by id.
 *
 * The input alone cannot say it. "Publish" with an id is not something a
 * person can check, so the screen reads what the id names as it stands now -
 * its title, its address, who reads it - and shows what confirming sets beside
 * each, as now and after. A change whose target is gone says so, and one the
 * person may no longer act on shows nothing of what stands there (ADR 0039).
 */
export function PendingChangeTarget({
  target,
  names = {},
}: {
  target: Target;
  /** What the person ids among the facts stand for, by id. */
  names?: Record<string, InputName>;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <h3 className="text-label text-ink-muted uppercase">
        {t("pendingChanges.target.heading")}
      </h3>
      <p className="text-small text-ink-muted">
        {t(KIND[target.kind])}{" "}
        <span className="font-data text-data">{target.id}</span>
      </p>
      {target.state === "missing" ? (
        <Notice tone="warn">{t(MISSING[target.kind])}</Notice>
      ) : target.state === "withheld" ? (
        <Notice tone="warn">{t("pendingChanges.target.withheld")}</Notice>
      ) : (
        <>
          <p className="text-small text-ink-muted">
            {t("pendingChanges.target.hint")}
          </p>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2">
            {target.facts.map((fact) => {
              const label = FACT[fact.fact];
              return (
                <div key={fact.fact} className="contents">
                  <dt className="text-small text-ink-muted">
                    {label === undefined ? (
                      <span className="font-data">{fact.fact}</span>
                    ) : (
                      t(label)
                    )}
                  </dt>
                  <dd className="text-body">
                    <FactChange fact={fact} names={names} />
                  </dd>
                </div>
              );
            })}
          </dl>
        </>
      )}
    </section>
  );
}

/** One fact as it is, and what confirming sets it to when it sets it. */
function FactChange({
  fact,
  names,
}: {
  fact: PendingChangeTargetFact;
  names: Record<string, InputName>;
}): ReactElement {
  const { t } = useTranslation();
  const now = <FactValue fact={fact.fact} value={fact.now} names={names} />;

  if (fact.after === undefined) {
    return now;
  }
  if (fact.after === fact.now) {
    return (
      <>
        {now}{" "}
        <span className="text-ink-muted">
          {t("pendingChanges.target.unchanged")}
        </span>
      </>
    );
  }
  return (
    <>
      {now} <span aria-hidden="true">→</span>{" "}
      <span className="sr-only">{t("pendingChanges.target.becomes")}</span>{" "}
      <strong className="font-semibold">
        <FactValue fact={fact.fact} value={fact.after} names={names} />
      </strong>
    </>
  );
}

function FactValue({
  fact,
  value,
  names,
}: {
  fact: string;
  value: string | boolean;
  names: Record<string, InputName>;
}): ReactElement {
  const { t } = useTranslation();

  if (typeof value === "boolean") {
    return (
      <span>
        {value ? t("pendingChanges.value.yes") : t("pendingChanges.value.no")}
      </span>
    );
  }
  const label = value === "" ? EMPTY[fact] : VALUE[fact]?.[value];
  if (label !== undefined) {
    return <span>{t(label)}</span>;
  }
  if (PERSON_FACTS.has(fact)) {
    return <PendingChangeInput value={value} names={names} />;
  }
  if (DATA_FACTS.has(fact)) {
    // An address, an issue number and a day are register data.
    return <span className="font-data text-data break-all">{value}</span>;
  }
  // As the input preview shows text: every space and line kept, and escaped.
  return <span className="break-words whitespace-pre-wrap">{value}</span>;
}
