import { useState, type ReactElement } from "react";
import type { NotReadView } from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import type { ApiFailure } from "../api/client";
import { fetchNotRead } from "../api/feed";
import { QUIET_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { authorLabel, Byline } from "./Author";
import { feedReadFailureKey } from "./feed-failures";

/**
 * Who in an important post's audience has not opened it yet: the board's
 * must-read list (ADR 0026).
 *
 * A notice about the water being shut off has to reach every household, and
 * this is how the board follows up the ones it has not reached. It is the one
 * place the feed names readers, and only for this: an important post, in an
 * audience the board may read, to the board. Everybody else reads "Läst av N"
 * and nothing more.
 *
 * Read when the board asks rather than with the post, so the names travel only
 * to somebody who wanted them, and read again on every ask, because the list
 * shrinks as the house reads. A person with protected personal data is listed
 * without their name, on the terms an author is.
 */
export function NotReadList({ postId }: { postId: string }): ReactElement {
  const { t } = useTranslation();
  const [read, setRead] = useState<
    | { kind: "closed" }
    | { kind: "reading" }
    | { kind: "read"; value: NotReadView }
    | { kind: "failed"; failure: ApiFailure }
  >({ kind: "closed" });

  const ask = async (): Promise<void> => {
    setRead({ kind: "reading" });
    const result = await fetchNotRead({ postId });
    setRead(
      result.ok
        ? { kind: "read", value: result.value }
        : { kind: "failed", failure: result.failure },
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={QUIET_BUTTON}
          disabled={read.kind === "reading"}
          aria-expanded={read.kind === "read"}
          onClick={() => {
            if (read.kind === "read") {
              setRead({ kind: "closed" });
              return;
            }
            void ask();
          }}
        >
          {read.kind === "reading"
            ? t("feed.notRead.reading")
            : read.kind === "read"
              ? t("feed.notRead.hide")
              : t("feed.notRead.show")}
        </button>
      </div>
      {read.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(feedReadFailureKey(read.failure))}
        </Notice>
      ) : null}
      {read.kind === "read" ? (
        read.value.people.length === 0 ? (
          <p role="status" className="text-small text-ink-muted">
            {t("feed.notRead.everybody")}
          </p>
        ) : (
          <section
            aria-label={t("feed.notRead.label")}
            className="flex flex-col gap-1"
          >
            <p role="status" className="text-small text-ink-muted">
              {t("feed.notRead.count", { count: read.value.people.length })}
            </p>
            <ul className="flex flex-col gap-1 text-small">
              {read.value.people.map((person, index) => (
                <li
                  key={
                    person.kind === "unknown"
                      ? `unknown-${String(index)}`
                      : person.personId
                  }
                  title={authorLabel(person, t)}
                >
                  <Byline author={person} byBoard={false} />
                </li>
              ))}
            </ul>
          </section>
        )
      ) : null}
    </div>
  );
}
