import { useId, useState, type ReactElement } from "react";
import type { FeedFrom } from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { Dialog } from "../ui/Dialog";

/** What the filter decides: who wrote it, and whether it is important. */
export interface PostFilter {
  from: FeedFrom | null;
  important: boolean;
}

/**
 * "Filtrera inlägg": posts from the board, posts from neighbours, important
 * ones only.
 *
 * Each choice only narrows, and only inside the audiences the reader is in: the
 * server applies it there, so a filter is a question about what the reader can
 * already see and never a way to see more.
 *
 * Chosen in the dialog and applied together when the reader presses the
 * button, so the feed is read once for the filter they settled on rather than
 * once for every box they ticked on the way to it.
 */
export function FilterDialog({
  value,
  onApply,
  onClose,
}: {
  value: PostFilter;
  onApply: (filter: PostFilter) => void;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [from, setFrom] = useState<FeedFrom | null>(value.from);
  const [important, setImportant] = useState(value.important);
  const formId = useId();
  const name = useId();

  const options: readonly { value: FeedFrom | null; label: string }[] = [
    { value: null, label: t("feed.filter.everyone") },
    { value: "board", label: t("feed.filter.board") },
    { value: "neighbours", label: t("feed.filter.neighbours") },
  ];

  return (
    <Dialog
      title={t("feed.filter.title")}
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => {
              onApply({ from: null, important: false });
            }}
          >
            {t("feed.filter.clear")}
          </button>
          <button type="submit" form={formId} className={PRIMARY_BUTTON}>
            {t("feed.filter.apply")}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          onApply({ from, important });
        }}
      >
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-label text-ink-muted uppercase">
            {t("feed.filter.from")}
          </legend>
          {options.map((option) => (
            <label
              key={option.value ?? "everyone"}
              className="flex min-h-11 items-center gap-3 text-body"
            >
              <input
                type="radio"
                name={name}
                className="size-4 accent-trust"
                checked={from === option.value}
                onChange={() => {
                  setFrom(option.value);
                }}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <label className="flex min-h-11 items-center gap-3 text-body">
          <input
            type="checkbox"
            className="size-4 accent-trust"
            checked={important}
            onChange={(event) => {
              setImportant(event.target.checked);
            }}
          />
          {t("feed.filter.important")}
        </label>
      </form>
    </Dialog>
  );
}
