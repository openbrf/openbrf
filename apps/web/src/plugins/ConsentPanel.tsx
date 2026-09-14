import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import type { CatalogPlugin } from "./plugin-api";
import {
  ACTION_EFFECT_LABELS,
  actionPersonalDataLabel,
  actionSurfaceLabel,
  permissionLabel,
  personalDataLabel,
} from "./plugin-labels";

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
          t(permissionLabel(permission)),
        )}
        emptyLabel={t("plugins.consent.noPermissions")}
      />

      <Declaration
        title={t("plugins.consent.personalDataTitle")}
        items={entry.personalData.map((category) =>
          t(personalDataLabel(category)),
        )}
        emptyLabel={t("plugins.consent.noPersonalData")}
      />

      {/*
        The widest part of the declaration, and so the part that most needs
        reading before anything is downloaded: an action names a capability and
        offers it to callers outside the board's own screens. Each entry says
        what it does to the records, because that is what separates one that
        reads the register from one that deletes out of it.

        No empty label, so a plugin proposing no action shows no list at all.
        The two above answer a question a board has whatever the plugin asked
        for - what may it do, whose data does it touch - and "nothing" is an
        answer to it. A plugin that proposes no action has not raised the
        question, and a heading saying so would introduce a mechanism this
        install does not use.
      */}
      <Declaration
        title={t("plugins.actions.title")}
        items={entry.actions.map((action) =>
          [
            action.id,
            action.capability,
            t(ACTION_EFFECT_LABELS[action.effect]),
            /*
             * The two halves that were missing, and the reason they belong on
             * THIS screen rather than beside the arming toggle: the board is
             * consenting to the declaration here, and an action's personal
             * data and its eligible surfaces are what the declaration is FOR.
             * The aggregate list above says which categories the plugin
             * touches somewhere; it cannot say which action receives each, and
             * it says nothing at all about how far one may be offered.
             */
            action.personalData.length === 0
              ? t("plugins.actions.noPersonalData")
              : action.personalData
                  .map((category) => t(actionPersonalDataLabel(category)))
                  .join(", "),
            action.surfaces
              .map((surface) => t(actionSurfaceLabel(surface)))
              .join(", "),
          ].join(" - "),
        )}
      />

      {/* min-h-11 is the 44px touch target: this checkbox is the control that
          records the board's consent, so it must not be the one control on the
          screen that is hard to hit on a phone. */}
      <label className="flex min-h-11 items-start gap-3">
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

/**
 * One list the board reads before it consents.
 *
 * A list with an empty label says "nothing" rather than going quiet, because
 * an absent list reads as a screen that failed to load. A list given none is
 * absent when it is empty instead: it belongs to a part of the declaration
 * that only some plugins raise at all, and a heading with nothing under it
 * would be the screen asking the board about a mechanism this install does not
 * use.
 */
function Declaration({
  title,
  items,
  emptyLabel,
}: {
  title: string;
  items: readonly string[];
  emptyLabel?: string;
}): ReactElement | null {
  if (items.length === 0 && emptyLabel === undefined) {
    return null;
  }

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
