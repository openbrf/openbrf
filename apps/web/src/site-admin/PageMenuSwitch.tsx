import { useEffect, useId, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { type AdminPage, setPageInMenu } from "../api/site";
import { HINT } from "../ui/controls";

/**
 * "Show in menu", on every page - the association's own and the built-in ones.
 *
 * On, the page's entry is added last on the top level and named for the page's
 * title; off, the page's entries are taken out of the menu. Where the entry
 * sits is arranged on the menu screen, and what a visitor is offered is
 * settled by who may open the page, so the switch says neither.
 *
 * It acts at once rather than with the page's save. The menu is its own
 * record with its own history, a page's unsaved words have nothing to do with
 * it, and a switch that waited for a save would leave the menu showing a page
 * the board had already turned off. For the same reason it is single-flight:
 * a second press while the first is being written is not taken, and the box
 * shows what the server last said rather than what was last asked.
 *
 * Only the answer's `inMenu` is handed up, on the page the screen holds. The
 * server answers with the whole page as it is now, and somebody else may have
 * saved it since this screen read it: taking that copy would hand the editor
 * the other version's revision under its own words, and its next save would
 * write over the other version without the warning a conflict gets.
 */

export interface PageMenuSwitchProps {
  page: AdminPage;
  /** Told of the page the screen holds, with whether it is now in the menu. */
  onChanged: (page: AdminPage) => void;
  /** Whether something else on the screen is being written. */
  busy?: boolean;
}

export function PageMenuSwitch({
  page,
  onChanged,
  busy = false,
}: PageMenuSwitchProps): ReactElement {
  const { t } = useTranslation();
  const hintId = useId();
  const [inMenu, setInMenu] = useState(page.inMenu);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<"added" | "removed" | "failed" | null>(
    null,
  );
  // Which page the box is showing, so an answer for one the board has left
  // does not touch the next one's switch, and the copy of it the screen holds
  // when the answer comes - a save may have moved it on while this was sent.
  const current = useRef(page);
  useEffect(() => {
    current.current = page;
  }, [page]);

  // What the server says about the page replaces what the box showed, and a
  // different page starts without the last one's outcome. Adjusted while
  // drawing rather than in an effect, so the old answer is never drawn.
  const [seen, setSeen] = useState({ id: page.id, inMenu: page.inMenu });
  if (seen.id !== page.id || seen.inMenu !== page.inMenu) {
    setSeen({ id: page.id, inMenu: page.inMenu });
    setInMenu(page.inMenu);
    if (seen.id !== page.id) {
      setOutcome(null);
    }
  }

  const change = async (wanted: boolean): Promise<void> => {
    if (saving) {
      return;
    }
    const asked = page.id;
    setSaving(true);
    setOutcome(null);
    const result = await setPageInMenu(asked, wanted);
    if (current.current.id !== asked) {
      return;
    }
    setSaving(false);
    if (result.ok) {
      setInMenu(result.value.inMenu);
      setOutcome(result.value.inMenu ? "added" : "removed");
      onChanged({ ...current.current, inMenu: result.value.inMenu });
    } else {
      setOutcome("failed");
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="flex min-h-11 items-start gap-3 text-small text-ink">
        <input
          type="checkbox"
          role="switch"
          checked={inMenu}
          disabled={busy || saving}
          aria-describedby={hintId}
          onChange={(event) => {
            void change(event.target.checked);
          }}
          className="mt-1 size-4 accent-trust"
        />
        {t("siteAdmin.editor.inMenu")}
      </label>
      <p id={hintId} className={HINT}>
        {t("siteAdmin.editor.inMenuHint")}
      </p>
      <p aria-live="polite" className={HINT} role="status">
        {outcome === "added"
          ? t("siteAdmin.editor.inMenuAdded")
          : outcome === "removed"
            ? t("siteAdmin.editor.inMenuRemoved")
            : outcome === "failed"
              ? t("siteAdmin.editor.inMenuFailed")
              : ""}
      </p>
    </div>
  );
}
