import type { ReactElement, ReactNode } from "react";

import type { Viewer } from "../api/instance";

/**
 * Whether this viewer is a support session (ADR 0028), which changes nothing.
 *
 * The one read-only signal the screens share. A support session holds
 * capabilities that name a write - `documents:manage`, `site:manage` - because
 * they open the screens an administrator runs the instance from, and the
 * screen still decides what to show from them. What it may not do is offer a
 * control that would send a change, so a screen asks this beside the
 * capability: what the viewer reads follows from the capability, what they may
 * change from the capability and this.
 *
 * Courtesy rather than enforcement, like every capability the interface reads:
 * the API refuses every change a support session sends whatever the screen
 * shows.
 */
export function isReadOnly(viewer: Pick<Viewer, "support">): boolean {
  return viewer.support != null;
}

/**
 * Disables every control inside it while `readOnly`, and adds no box of its own.
 *
 * For a region whose controls all send a change, such as a settings panel or
 * the fields of a form a supporter may read but not save. A disabled fieldset
 * reaches each input, select, textarea and button below it, so a control added
 * there later is read-only for a supporter without anybody remembering to make
 * it so. It does not reach a link or an editable text area, and a region
 * holding one of those, or a control that only reads, says so itself instead.
 */
export function ReadOnlyRegion({
  readOnly,
  children,
}: {
  readOnly: boolean;
  children: ReactNode;
}): ReactElement {
  return readOnly ? (
    <fieldset disabled className="contents">
      {children}
    </fieldset>
  ) : (
    <>{children}</>
  );
}
