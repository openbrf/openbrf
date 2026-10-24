import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import { Notice } from "../ui/Notice";
import type {
  PendingChangeTarget as Target,
  PendingChangeTargetFact,
} from "./pending-changes-api";

const KIND = {
  news: "pendingChanges.target.kind.news",
  page: "pendingChanges.target.kind.page",
} as const satisfies Record<Target["kind"], TranslationKey>;

const MISSING = {
  news: "pendingChanges.target.missing.news",
  page: "pendingChanges.target.missing.page",
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
};

/**
 * What a pending change is to: the news item or page its input names by id.
 *
 * The input alone cannot say it. "Publish" with an id is not something a
 * person can check, so the screen reads what the id names as it stands now -
 * its title, its address, who reads it - and shows what confirming sets beside
 * each, as now and after. A change whose target is gone says so, and one the
 * person may no longer act on shows nothing of what stands there (ADR 0039).
 */
export function PendingChangeTarget({
  target,
}: {
  target: Target;
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
                    <FactChange fact={fact} />
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
function FactChange({ fact }: { fact: PendingChangeTargetFact }): ReactElement {
  const { t } = useTranslation();
  const now = <FactValue fact={fact.fact} value={fact.now} />;

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
        <FactValue fact={fact.fact} value={fact.after} />
      </strong>
    </>
  );
}

function FactValue({
  fact,
  value,
}: {
  fact: string;
  value: string | boolean;
}): ReactElement {
  const { t } = useTranslation();

  if (typeof value === "boolean") {
    return (
      <span>
        {value ? t("pendingChanges.value.yes") : t("pendingChanges.value.no")}
      </span>
    );
  }
  const label = VALUE[fact]?.[value];
  if (label !== undefined) {
    return <span>{t(label)}</span>;
  }
  if (fact === "slug") {
    // An address is register data, and is read character by character.
    return <span className="font-data text-data break-all">{value}</span>;
  }
  // As the input preview shows text: every space and line kept, and escaped.
  return <span className="break-words whitespace-pre-wrap">{value}</span>;
}
