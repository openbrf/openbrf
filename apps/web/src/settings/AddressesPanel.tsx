import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { AddressView } from "../api/instance";
import { createAddress, removeAddress } from "../api/instance";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, LABEL, PRIMARY_BUTTON, QUIET_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

export interface AddressesPanelProps {
  addresses: readonly AddressView[];
  /** Called after any change, so the caller can reload the list. */
  onChanged: () => void;
  editable?: boolean;
}

const EMPTY = { street: "", number: "", postalCode: "", city: "" };

const ADDRESS_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "address-exists": "settings.addresses.errors.exists",
  "has-apartments": "settings.addresses.errors.hasApartments",
  "not-found": "settings.addresses.errors.notFound",
  "invalid-body": "settings.addresses.errors.unknown",
};

/**
 * The housing cooperative's street addresses.
 *
 * A list from the start, because a cooperative commonly owns several entrances
 * and the address book renders one board per address. The project owner called
 * this out explicitly: a single-address form that grew a second one later would
 * have been the wrong shape.
 */
export function AddressesPanel({
  addresses,
  onChanged,
  editable = true,
}: AddressesPanelProps): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(EMPTY);

  const add = useSaveAction(createAddress, () => {
    setDraft(EMPTY);
    onChanged();
  });
  const remove = useSaveAction(removeAddress, onChanged);

  const failure =
    add.state.kind === "failed"
      ? add.state.failure
      : remove.state.kind === "failed"
        ? remove.state.failure
        : null;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void add.submit({
      street: draft.street.trim(),
      number: draft.number.trim(),
      postalCode: draft.postalCode.trim(),
      city: draft.city.trim(),
    });
  };

  const complete =
    draft.street.trim() !== "" &&
    draft.number.trim() !== "" &&
    draft.postalCode.trim() !== "" &&
    draft.city.trim() !== "";

  return (
    <Panel
      title={t("settings.addresses.title")}
      description={t("settings.addresses.description")}
      notice={
        failure === null ? null : (
          <Notice tone="danger" live>
            {t(
              failureMessageKey(
                failure,
                ADDRESS_FAILURES,
                "settings.addresses.errors.unknown",
              ),
            )}
          </Notice>
        )
      }
    >
      {addresses.length === 0 ? (
        <p className="text-body text-ink-muted">
          {t("settings.addresses.none")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {addresses.map((address) => (
            <li
              key={address.id}
              className="flex flex-wrap items-center gap-3 rounded-control border border-line bg-page px-3 py-2.5"
            >
              <span className="text-body font-semibold">
                {address.street} {address.number}
              </span>
              {/* Postal code and city are register data: mono grid. */}
              <span className="font-data text-data text-ink-muted">
                {address.postalCode} {address.city}
              </span>
              <span className="ml-auto font-data text-data text-ink-muted">
                {t("settings.addresses.apartmentCount", {
                  count: address.apartmentCount,
                })}
              </span>
              {editable ? (
                <button
                  type="button"
                  aria-label={t("settings.addresses.removeLabel", {
                    address: `${address.street} ${address.number}`,
                  })}
                  disabled={remove.state.kind === "saving"}
                  onClick={() => {
                    void remove.submit(address.id);
                  }}
                  className={QUIET_BUTTON}
                >
                  {t("settings.addresses.remove")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {editable ? (
        <form
          className="flex flex-col gap-4 border-t border-line pt-4"
          onSubmit={onSubmit}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label className={LABEL}>
              {t("settings.addresses.street")}
              <input
                type="text"
                name="street"
                autoComplete="off"
                value={draft.street}
                onChange={(event) => {
                  setDraft({ ...draft, street: event.target.value });
                }}
                className={FIELD}
              />
            </label>

            <label className={LABEL}>
              {t("settings.addresses.number")}
              <input
                type="text"
                name="streetNumber"
                autoComplete="off"
                value={draft.number}
                onChange={(event) => {
                  setDraft({ ...draft, number: event.target.value });
                }}
                className={`${FIELD} font-data`}
              />
            </label>

            <label className={LABEL}>
              {t("settings.addresses.postalCode")}
              <input
                type="text"
                name="postalCode"
                inputMode="numeric"
                autoComplete="off"
                value={draft.postalCode}
                onChange={(event) => {
                  setDraft({ ...draft, postalCode: event.target.value });
                }}
                className={`${FIELD} font-data`}
              />
            </label>

            <label className={LABEL}>
              {t("settings.addresses.city")}
              <input
                type="text"
                name="city"
                autoComplete="off"
                value={draft.city}
                onChange={(event) => {
                  setDraft({ ...draft, city: event.target.value });
                }}
                className={FIELD}
              />
            </label>
          </div>

          <div>
            <button
              type="submit"
              disabled={!complete || add.state.kind === "saving"}
              className={PRIMARY_BUTTON}
            >
              {add.state.kind === "saving"
                ? t("settings.saving")
                : t("settings.addresses.add")}
            </button>
          </div>
        </form>
      ) : null}
    </Panel>
  );
}
