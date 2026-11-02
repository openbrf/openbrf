import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";
import type { PluginAccessReason } from "@openbrf/shared";

import { localDayOfInstant } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import { CAUTION_BUTTON, FIELD, LABEL, SECONDARY_BUTTON } from "../ui/controls";
import {
  fetchGrantablePlugins,
  type GrantablePlugin,
  type PersonDetail,
  RegisterRequestError,
  setPluginAccess,
} from "./register-api";

/**
 * A sentence for every refusal the grant and the withdrawal answer with.
 * Typed from the shared union, so a reason the API adds without a sentence
 * here fails the build.
 */
const PLUGIN_ACCESS_ERROR: Readonly<
  Record<PluginAccessReason, TranslationKey>
> = {
  "person-not-found": "register.person.pluginAccess.errors.notFound",
  "plugin-not-found": "register.person.pluginAccess.errors.pluginNotFound",
  "plugin-access-not-served": "register.person.pluginAccess.errors.notServed",
  "person-has-residency": "register.person.pluginAccess.errors.hasResidency",
};

function pluginAccessErrorMessage(error: unknown): TranslationKey {
  if (error instanceof RegisterRequestError) {
    const known =
      error.reason === null
        ? undefined
        : (PLUGIN_ACCESS_ERROR as Readonly<Record<string, TranslationKey>>)[
            error.reason
          ];
    if (known !== undefined) {
      return known;
    }
    if (error.status === 403) {
      return "register.person.pluginAccess.errors.forbidden";
    }
  }
  return "register.person.pluginAccess.errors.failed";
}

export interface PluginAccessSectionProps {
  person: PersonDetail;
  /** Whether the viewer may grant and withdraw: `addressBook:write`. */
  canWrite: boolean;
  /** Reads the person again, after a change was saved or may have been. */
  onSaved: () => void;
}

/**
 * The plugin accesses on a person's page (tilläggsåtkomst, ADR 0053): which
 * plugins made for residents serve this person although they do not live
 * here, since when, and the board's grant and withdrawal.
 *
 * Offered only for a person with no residency on record, because the API
 * refuses the grant for anybody else and recording a residency ends every
 * access. An account for such a person is the invitation below this section,
 * as for anybody the board adds without a residency.
 */
export function PluginAccessSection({
  person,
  canWrite,
  onSaved,
}: PluginAccessSectionProps): ReactElement | null {
  const { t } = useTranslation();
  const headingId = useId();
  const selectId = useId();
  const neverLivedHere = person.residencies.length === 0;
  const offerGrant = canWrite && neverLivedHere;

  const [grantable, setGrantable] = useState<GrantablePlugin[] | null>(null);
  const [grantableFailed, setGrantableFailed] = useState(false);
  const [chosen, setChosen] = useState("");
  /** The plugin whose access is being saved; one change at a time. */
  const [saving, setSaving] = useState<string | null>(null);
  const savingRef = useRef(false);
  const [failure, setFailure] = useState<TranslationKey | null>(null);

  useEffect(() => {
    if (!offerGrant) {
      return;
    }
    let current = true;
    void (async () => {
      try {
        const plugins = await fetchGrantablePlugins();
        if (current) {
          setGrantable(plugins);
          setGrantableFailed(false);
        }
      } catch {
        if (current) {
          setGrantable(null);
          setGrantableFailed(true);
        }
      }
    })();
    return () => {
      current = false;
    };
  }, [offerGrant]);

  const held = new Set(person.pluginAccesses.map((access) => access.pluginId));
  const offered = (grantable ?? []).filter(
    (plugin) => !held.has(plugin.pluginId),
  );
  // The choice is kept only while it is still on offer, so a plugin granted a
  // moment ago, or one that stopped serving the class, is never sent again.
  const choice = offered.some((plugin) => plugin.pluginId === chosen)
    ? chosen
    : (offered[0]?.pluginId ?? "");

  /*
   * A failure must not look like success, and an answer that never came must
   * not look like either: the person is read again whatever happened, so the
   * page shows the accesses the register holds and not the ones it assumed.
   */
  const change = async (pluginId: string, granted: boolean): Promise<void> => {
    if (savingRef.current) {
      return;
    }
    savingRef.current = true;
    setFailure(null);
    setSaving(pluginId);
    try {
      await setPluginAccess(person.personId, pluginId, granted);
    } catch (error) {
      setFailure(pluginAccessErrorMessage(error));
    } finally {
      savingRef.current = false;
      setSaving(null);
      onSaved();
    }
  };

  if (person.pluginAccesses.length === 0 && !offerGrant) {
    return null;
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 border-t border-line pt-4"
    >
      <h3 id={headingId} className="text-title">
        {t("register.person.pluginAccess.heading")}
      </h3>
      <p className="text-small text-ink-muted">
        {t("register.person.pluginAccess.explained")}
      </p>

      {person.pluginAccesses.length === 0 ? (
        <p className="text-body text-ink">
          {t("register.person.pluginAccess.none")}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {person.pluginAccesses.map((access) => (
            <li
              key={access.pluginId}
              className="flex flex-col gap-1.5 border-t border-line pt-2"
            >
              <span className="text-body text-ink">{access.pluginName}</span>
              <span className="font-data text-data text-ink">
                {t("register.person.pluginAccess.since", {
                  date: localDayOfInstant(access.grantedAt),
                })}
              </span>
              {canWrite ? (
                <button
                  type="button"
                  onClick={() => {
                    void change(access.pluginId, false);
                  }}
                  disabled={saving !== null}
                  aria-label={t("register.person.pluginAccess.withdrawLabel", {
                    plugin: access.pluginName,
                  })}
                  className={`${CAUTION_BUTTON} self-start disabled:opacity-60`}
                >
                  {saving === access.pluginId
                    ? t("register.person.pluginAccess.working")
                    : t("register.person.pluginAccess.withdraw")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {offerGrant && grantableFailed ? (
        <p role="alert" className="text-small text-danger">
          {t("register.person.pluginAccess.errors.pluginsUnavailable")}
        </p>
      ) : null}
      {offerGrant && grantable !== null && offered.length === 0 ? (
        // Two different empty lists: none installed serves the class, and the
        // person already holds every one that does. `offered` leaves out the
        // held ones, so it alone cannot tell them apart.
        <p className="text-small text-ink-muted">
          {t(
            grantable.length === 0
              ? "register.person.pluginAccess.noPlugins"
              : "register.person.pluginAccess.allGranted",
          )}
        </p>
      ) : null}
      {offerGrant && offered.length > 0 ? (
        <div className="flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <label className={LABEL} htmlFor={selectId}>
            {t("register.person.pluginAccess.plugin")}
            <select
              id={selectId}
              value={choice}
              onChange={(event) => {
                setChosen(event.target.value);
                setFailure(null);
              }}
              className={FIELD}
            >
              {offered.map((plugin) => (
                <option key={plugin.pluginId} value={plugin.pluginId}>
                  {plugin.pluginName}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => {
              void change(choice, true);
            }}
            disabled={saving !== null || choice === ""}
            className={`${SECONDARY_BUTTON} disabled:opacity-60`}
          >
            {saving === choice
              ? t("register.person.pluginAccess.working")
              : t("register.person.pluginAccess.grant")}
          </button>
        </div>
      ) : null}

      {failure === null ? null : (
        <p role="alert" className="text-small text-danger">
          {t(failure)}
        </p>
      )}
    </section>
  );
}
