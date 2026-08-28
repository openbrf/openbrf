import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import type { CatalogPlugin } from "./plugin-api";
import { PERMISSION_LABELS, PERSONAL_DATA_LABELS } from "./plugin-labels";

export interface ConsentPanelProps {
  entry: CatalogPlugin;
  /** The board's language, for the catalog's own bilingual text. */
  locale: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * What a board agrees to before a plugin is installed.
 *
 * The screen exists because a backend plugin runs at full process privilege
 * (ADR 0003 - there is no sandbox in v1). Curation of the catalog is what
 * stands between an instance and hostile code; this is what stands between a
 * board and code that is merely more far-reaching than they expected. So it
 * states the two things a board is answerable for under GDPR - what the plugin
 * may do, and which personal data it will handle - in full sentences rather
 * than as permission codes.
 *
 * The two limits that hold regardless of what a plugin asked for are stated
 * here as well, because a board reading a list of permissions has no other way
 * to know where the list stops.
 */
export function ConsentPanel({
  entry,
  locale,
  busy = false,
  onConfirm,
  onCancel,
}: ConsentPanelProps): ReactElement {
  const { t } = useTranslation();
  const [understood, setUnderstood] = useState(false);
  const swedish = locale.startsWith("sv");

  return (
    <Panel
      title={t("plugins.consent.title")}
      description={t("plugins.consent.intro", {
        name: swedish ? entry.name.sv : entry.name.en,
        version: entry.version,
      })}
      notice={<Notice tone="info">{t("plugins.consent.privacyNote")}</Notice>}
      actions={
        <>
          <button
            type="button"
            disabled={!understood || busy}
            onClick={onConfirm}
            className={PRIMARY_BUTTON}
          >
            {busy
              ? t("plugins.consent.installing")
              : t("plugins.consent.confirm")}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className={SECONDARY_BUTTON}
          >
            {t("plugins.consent.cancel")}
          </button>
        </>
      }
    >
      <p className="text-body text-ink">
        {swedish ? entry.description.sv : entry.description.en}
      </p>

      <Declaration
        title={t("plugins.consent.permissionsTitle")}
        items={entry.permissions.map((permission) =>
          t(PERMISSION_LABELS[permission] ?? "plugins.permissions.unknown"),
        )}
        emptyLabel={t("plugins.consent.noPermissions")}
      />

      <Declaration
        title={t("plugins.consent.personalDataTitle")}
        items={entry.personalData.map((category) =>
          t(PERSONAL_DATA_LABELS[category] ?? "plugins.personalData.unknown"),
        )}
        emptyLabel={t("plugins.consent.noPersonalData")}
      />

      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          name="understood"
          checked={understood}
          onChange={(event) => {
            setUnderstood(event.target.checked);
          }}
          className="mt-1 size-5 rounded-control border border-line-strong"
        />
        <span className="text-small text-ink">
          {t("plugins.consent.acknowledge")}
        </span>
      </label>
    </Panel>
  );
}

function Declaration({
  title,
  items,
  emptyLabel,
}: {
  title: string;
  items: readonly string[];
  emptyLabel: string;
}): ReactElement {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label text-ink-muted uppercase">{title}</h3>
      {items.length === 0 ? (
        <p className="text-small text-ink-muted">{emptyLabel}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li
              key={item}
              className="border-l-2 border-line-strong pl-3 text-small text-ink"
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
