import { Link } from "@tanstack/react-router";
import type { ReactElement, ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import { SECONDARY_BUTTON } from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { Panel } from "../ui/Panel";
import type { ReadState } from "./use-read";

/** One row of a list in the room, the shape every list on the page shares. */
export const ITEM_ROW =
  "flex flex-wrap items-center gap-3 rounded-control border border-line bg-page px-3 py-3";

/**
 * A link in a row of the room: ink, with the rule under it, and a hit area of
 * the 44px a thumb needs.
 */
export const ITEM_LINK =
  "inline-flex min-h-11 items-center text-ink underline decoration-line-strong underline-offset-4";

/**
 * One panel of the overview around its own read.
 *
 * Reading, failed and read are the panel's states and nobody else's: a
 * failure shows the panel's own sentence and a retry that runs this panel's
 * read again, and the rest of the page goes on as it was.
 */
export function ReadPanel<T>({
  title,
  description,
  read,
  failureKey,
  onRetry,
  more,
  children,
}: {
  title: string;
  description: string;
  read: ReadState<T>;
  /** The sentence for this panel's own failed read. */
  failureKey: TranslationKey;
  onRetry: () => void;
  /** The screen this panel is a glimpse of, and what to call the link. */
  more?: { to: string; label: string };
  children: (value: T) => ReactNode;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <Panel
      title={title}
      description={description}
      actions={
        more === undefined ? undefined : (
          <Link to={more.to} className={SECONDARY_BUTTON}>
            {more.label}
          </Link>
        )
      }
    >
      {read.kind === "loading" ? (
        <p role="status" className="text-body text-ink-muted">
          {t("app.loading")}
        </p>
      ) : read.kind === "failed" ? (
        <LoadFailure messageKey={failureKey} onRetry={onRetry} />
      ) : (
        children(read.value)
      )}
    </Panel>
  );
}
