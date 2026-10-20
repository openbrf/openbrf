import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

/**
 * What a pending change would send, field by field.
 *
 * The generic preview (ADR 0039): the held input exactly as the action will
 * receive it, with nothing summarised, re-worded or left out, because whatever
 * this screen does not show is something the person confirms without having
 * seen. Field names are the action's own, in the data face, since they are what
 * the call carries; the values are shown as they are. A preview shaped by each
 * action - a page as it will look - is a later addition beside this one, not a
 * replacement for it.
 *
 * Text is rendered as text. A value a model wrote can hold anything, and React
 * escapes it like any other string, so markup in it is shown rather than run.
 */
export function PendingChangeInput({
  value,
}: {
  value: unknown;
}): ReactElement {
  const { t } = useTranslation();

  if (value === null || value === undefined) {
    return (
      <span className="text-ink-muted">{t("pendingChanges.value.none")}</span>
    );
  }
  if (typeof value === "string") {
    return value === "" ? (
      <span className="text-ink-muted">{t("pendingChanges.value.empty")}</span>
    ) : (
      <span className="break-words whitespace-pre-line">{value}</span>
    );
  }
  if (typeof value === "number") {
    return <span className="font-data text-data">{String(value)}</span>;
  }
  if (typeof value === "boolean") {
    return (
      <span>
        {value ? t("pendingChanges.value.yes") : t("pendingChanges.value.no")}
      </span>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <span className="text-ink-muted">{t("pendingChanges.value.none")}</span>
      );
    }
    return (
      <ol className="flex list-decimal flex-col gap-2 pl-5">
        {value.map((item: unknown, index) => (
          // A position is the only identity an element of an input has.
          <li key={index}>
            <PendingChangeInput value={item} />
          </li>
        ))}
      </ol>
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return (
      <span className="text-ink-muted">{t("pendingChanges.value.none")}</span>
    );
  }
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2">
      {entries.map(([key, item]) => (
        <div key={key} className="contents">
          <dt className="font-data text-small text-ink-muted">{key}</dt>
          <dd className="text-body">
            <PendingChangeInput value={item} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
