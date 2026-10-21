import type { BlockCategory, BlockIcon } from "@openbrf/shared";
import { useEffect, useId, useRef, useState } from "react";
import type { ReactElement, Ref } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import { Dialog } from "../ui/Dialog";
import { FIELD, HINT, LABEL, SECONDARY_BUTTON } from "../ui/controls";
import { EditorIcon } from "./EditorIcon";

/**
 * The + that adds a block, and the list of blocks it offers.
 *
 * One with the tools over every block, which adds the next block after it,
 * and one at the end of the page and in each empty column, so a block is
 * added where it is wanted rather than at the bottom and moved up. The list is every block that may stand there, filed under the
 * categories the registry gives them and searchable by name, because a list
 * of sixteen buttons in a row is a list nobody reads to the end.
 *
 * A dialog, the browser's own: the page behind it is inert while it is open,
 * Escape closes it, and the focus comes back to the + it was opened from.
 */

/** One block the + offers, in the board's own language. */
export interface InserterChoice {
  /** The block type, as the registry knows it. */
  type: string;
  label: string;
  icon: BlockIcon;
  category: BlockCategory;
}

/** The categories, in the order the list shows them. */
const CATEGORIES = [
  ["text", "siteAdmin.editor.categories.text"],
  ["media", "siteAdmin.editor.categories.media"],
  ["layout", "siteAdmin.editor.categories.layout"],
  ["association", "siteAdmin.editor.categories.association"],
] as const satisfies readonly (readonly [BlockCategory, TranslationKey])[];

export interface BlockInserterProps {
  /** Says where the block goes, for a screen reader and as a tooltip. */
  label: string;
  choices: readonly InserterChoice[];
  onChoose: (type: string) => void;
  /** Why nothing can be added here, when nothing can; null when it can. */
  full: string | null;
  /**
   * How the + is drawn: on its own line with its words beside it, at the end
   * of the page or a column, or as one of the tools over a selected block,
   * which adds the block after it.
   */
  look: "end" | "tool";
  ref?: Ref<HTMLButtonElement>;
}

export function BlockInserter({
  label,
  choices,
  onChoose,
  full,
  look,
  ref,
}: BlockInserterProps): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchHint = useId();
  /*
   * The block chosen, added once the dialog has closed. Closing hands the
   * focus back to the + it was opened from, and a block added before that
   * would have the focus it took taken away again.
   */
  const chosen = useRef<string | null>(null);
  useEffect(() => {
    const type = chosen.current;
    if (!open && type !== null) {
      chosen.current = null;
      onChoose(type);
    }
  }, [open, onChoose]);

  const needle = query.trim().toLocaleLowerCase();
  const matching = choices.filter((choice) =>
    choice.label.toLocaleLowerCase().includes(needle),
  );

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={full ?? label}
        aria-disabled={full !== null}
        data-canvas-inserter=""
        className={
          look === "end"
            ? `${SECONDARY_BUTTON} gap-2 aria-disabled:opacity-60`
            : "inline-flex size-11 items-center justify-center rounded-control text-ink-muted transition-colors duration-150 ease-out hover:bg-sunken hover:text-ink aria-disabled:opacity-60"
        }
        onClick={() => {
          if (full !== null) {
            return;
          }
          setQuery("");
          setOpen(true);
        }}
      >
        <EditorIcon name="add" />
        {look === "end" ? (
          <span aria-hidden="true">{t("siteAdmin.editor.inserter.add")}</span>
        ) : null}
      </button>
      {open ? (
        <Dialog
          title={t("siteAdmin.editor.inserter.title")}
          onClose={() => {
            setOpen(false);
          }}
          actions={
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => {
                setOpen(false);
              }}
            >
              {t("siteAdmin.editor.inserter.cancel")}
            </button>
          }
        >
          <label className={LABEL}>
            {t("siteAdmin.editor.inserter.search")}
            <input
              type="search"
              className={FIELD}
              value={query}
              aria-describedby={searchHint}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </label>
          {/* How many blocks the search leaves, said as it changes. */}
          <p id={searchHint} className={HINT} role="status">
            {matching.length === 0
              ? t("siteAdmin.editor.inserter.none")
              : t("siteAdmin.editor.inserter.count", {
                  count: matching.length,
                })}
          </p>
          <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
            {CATEGORIES.map(([category, key]) => {
              const inCategory = matching.filter(
                (choice) => choice.category === category,
              );
              if (inCategory.length === 0) {
                return null;
              }
              return (
                <section key={category} className="flex flex-col gap-2">
                  <h3 className="text-label text-ink-muted uppercase">
                    {t(key)}
                  </h3>
                  <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {inCategory.map((choice) => (
                      <li key={choice.type}>
                        <button
                          type="button"
                          className="flex min-h-11 w-full items-center gap-3 rounded-control border border-line bg-raised px-3 text-left text-small text-ink transition-colors duration-150 ease-out hover:bg-sunken"
                          onClick={() => {
                            chosen.current = choice.type;
                            setOpen(false);
                          }}
                        >
                          <EditorIcon name={choice.icon} />
                          {choice.label}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
