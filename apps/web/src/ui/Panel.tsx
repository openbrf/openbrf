import type { ReactElement, ReactNode } from "react";

import { PANEL } from "./controls";

export interface PanelProps {
  title: string;
  /** One sentence saying what this setting decides. Never decoration. */
  description?: string;
  /** Standing notices: an unconfigured state, a legal note, a refusal. */
  notice?: ReactNode;
  children: ReactNode;
  /** Actions, laid out along the bottom edge. */
  actions?: ReactNode;
}

/**
 * One settings panel: a card in the room.
 *
 * The wizard and the settings screen render the same panels, which is why they
 * are components rather than markup inside either. Everything the wizard can
 * skip has to be completable later in settings, so building the two screens out
 * of one set of parts is what makes that true by construction instead of by
 * remembering.
 */
export function Panel({
  title,
  description,
  notice,
  children,
  actions,
}: PanelProps): ReactElement {
  return (
    <section className={`flex flex-col gap-4 ${PANEL}`}>
      <header className="flex flex-col gap-1">
        <h2 className="text-title">{title}</h2>
        {description === undefined ? null : (
          <p className="text-small text-ink-muted">{description}</p>
        )}
      </header>

      {notice}

      <div className="flex flex-col gap-4">{children}</div>

      {actions === undefined ? null : (
        <footer className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          {actions}
        </footer>
      )}
    </section>
  );
}
