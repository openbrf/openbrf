import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { ApartmentView, AddressView } from "../api/instance";
import { fetchAddresses, fetchApartments } from "../api/instance";
import type { TranslationKey } from "../i18n/translation-key";
import { fetchApartment } from "../register/register-api";
import { usePanelHeadingFocus } from "../register/use-panel-heading-focus";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { moveIn, type MoveInResult, type MoveRole } from "./moves-api";
import { failureMessage } from "./move-errors";
import { PersonSearch, type PersonOption } from "./PersonSearch";

/**
 * Moving someone into an apartment.
 *
 * The panel states what the flow does beyond creating a residency, because the
 * rest of it cannot be undone: moving someone in as a member writes the entry
 * in the statutory member register, and a transfer recorded here goes into the
 * apartment register. Both are append-only.
 *
 * The previous holder is offered from the apartment's own current holders
 * rather than as another free search: a transfer is between the person leaving
 * and the person arriving, and picking a stranger from the whole register would
 * be a typing mistake nobody could correct afterwards.
 */

const ROLES: readonly MoveRole[] = ["MEMBER", "RESIDENT"];

export function MoveInPanel({
  onClose,
  onMoved,
}: {
  onClose: () => void;
  /** Called after a successful move so the register reloads. */
  onMoved: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const heading = usePanelHeadingFocus();

  const [person, setPerson] = useState<PersonOption | null>(null);
  const [addresses, setAddresses] = useState<AddressView[]>([]);
  const [addressId, setAddressId] = useState("");
  /*
   * Both lists are stored with the id they were loaded for, so a list that
   * belongs to the previously chosen address or apartment is never offered:
   * comparing the ids during render answers "is this still the right list"
   * without an effect to clear it.
   */
  const [apartments, setApartments] = useState<{
    addressId: string;
    rows: ApartmentView[];
  }>({ addressId: "", rows: [] });
  const [apartmentId, setApartmentId] = useState("");
  const [holders, setHolders] = useState<{
    apartmentId: string;
    rows: PersonOption[];
  }>({ apartmentId: "", rows: [] });
  const [role, setRole] = useState<MoveRole>("MEMBER");
  const [movedInOn, setMovedInOn] = useState("");
  const [recordTransfer, setRecordTransfer] = useState(false);
  const [transferredOn, setTransferredOn] = useState("");
  const [fromPersonId, setFromPersonId] = useState("");
  const [price, setPrice] = useState("");
  const [agreementReference, setAgreementReference] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<TranslationKey | null>(null);
  const [result, setResult] = useState<MoveInResult | null>(null);
  const [apartmentNumber, setApartmentNumber] = useState("");

  useEffect(() => {
    void (async () => {
      const found = await fetchAddresses();
      if (found.ok) {
        setAddresses(found.value);
        setAddressId(found.value[0]?.id ?? "");
      }
    })();
  }, []);

  useEffect(() => {
    if (addressId === "") {
      return;
    }
    void (async () => {
      const found = await fetchApartments(addressId);
      setApartments({ addressId, rows: found.ok ? found.value : [] });
    })();
  }, [addressId]);

  /*
   * The apartment's current holders, offered as the other party to a transfer.
   * Loaded per apartment rather than once, because who holds it is the whole
   * question the transfer answers.
   */
  useEffect(() => {
    if (apartmentId === "") {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const detail = await fetchApartment(apartmentId, controller.signal);
        setHolders({
          apartmentId,
          rows: detail.residents
            .filter((resident) => resident.role === "MEMBER")
            .map((resident) => ({
              personId: resident.personId,
              name: resident.name,
            })),
        });
      } catch {
        setHolders({ apartmentId, rows: [] });
      }
    })();
    return () => {
      controller.abort();
    };
  }, [apartmentId]);

  const apartmentOptions =
    apartments.addressId === addressId ? apartments.rows : [];
  const holderOptions = holders.apartmentId === apartmentId ? holders.rows : [];

  const submit = async (): Promise<void> => {
    if (person === null || apartmentId === "") {
      return;
    }
    setSubmitting(true);
    setFailure(null);

    const chosen = apartmentOptions.find(
      (apartment) => apartment.id === apartmentId,
    );
    const response = await moveIn({
      personId: person.personId,
      apartmentId,
      role,
      movedInOn,
      transfer: recordTransfer
        ? {
            transferredOn,
            fromPersonId: fromPersonId === "" ? null : fromPersonId,
            price: price.trim() === "" ? null : price.trim(),
            agreementReference:
              agreementReference.trim() === ""
                ? null
                : agreementReference.trim(),
          }
        : undefined,
    });

    setSubmitting(false);
    if (!response.ok) {
      setFailure(failureMessage(response.failure.reason));
      return;
    }
    setApartmentNumber(chosen?.number ?? "");
    setResult(response.value);
    onMoved();
  };

  return (
    <aside
      aria-label={t("moves.in.heading")}
      className="flex flex-col gap-5 rounded-panel border border-line bg-raised p-5 shadow-raised"
    >
      <div className="flex items-start justify-between gap-4">
        <h2 ref={heading} tabIndex={-1} className="text-headline">
          {t("moves.in.heading")}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 rounded-control border border-line-strong px-3 text-small font-semibold text-ink"
        >
          {t("moves.cancel")}
        </button>
      </div>

      {result === null ? (
        <>
          <p className="text-body text-ink-muted">
            {t("moves.in.description")}
          </p>

          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <PersonSearch
              id="move-in-person"
              label={t("moves.in.person")}
              selected={person}
              onSelect={setPerson}
            />

            <label className={LABEL} htmlFor="move-in-address">
              {t("settings.addresses.title")}
              <select
                id="move-in-address"
                value={addressId}
                onChange={(event) => {
                  setAddressId(event.target.value);
                  // The chosen apartment belonged to the previous address.
                  setApartmentId("");
                }}
                className={FIELD}
              >
                {addresses.map((address) => (
                  <option key={address.id} value={address.id}>
                    {`${address.street} ${address.number}`}
                  </option>
                ))}
              </select>
            </label>

            <label className={LABEL} htmlFor="move-in-apartment">
              {t("moves.in.apartment")}
              <select
                id="move-in-apartment"
                required
                value={apartmentId}
                onChange={(event) => {
                  setApartmentId(event.target.value);
                }}
                className={FIELD_DATA}
              >
                <option value="" />
                {apartmentOptions.map((apartment) => (
                  <option key={apartment.id} value={apartment.id}>
                    {apartment.number}
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-label text-ink-muted uppercase">
                {t("moves.in.role")}
              </legend>
              {ROLES.map((candidate) => (
                <label
                  key={candidate}
                  className="flex min-h-11 items-center gap-3 text-body text-ink"
                >
                  <input
                    type="radio"
                    name="move-in-role"
                    value={candidate}
                    checked={role === candidate}
                    onChange={() => {
                      setRole(candidate);
                    }}
                    className="size-4 accent-trust"
                  />
                  {candidate === "MEMBER"
                    ? t("moves.in.roleMember")
                    : t("moves.in.roleResident")}
                </label>
              ))}
            </fieldset>

            <label className={LABEL} htmlFor="move-in-date">
              {t("moves.in.movedInOn")}
              <input
                id="move-in-date"
                type="date"
                required
                value={movedInOn}
                onChange={(event) => {
                  setMovedInOn(event.target.value);
                }}
                className={FIELD_DATA}
              />
            </label>

            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <label className="flex min-h-11 items-center gap-3 text-body text-ink">
                <input
                  type="checkbox"
                  checked={recordTransfer}
                  onChange={(event) => {
                    setRecordTransfer(event.target.checked);
                  }}
                  className="size-5 accent-trust"
                />
                {t("moves.transfer.record")}
              </label>
              <p className={HINT}>{t("moves.transfer.hint")}</p>
            </div>

            {recordTransfer ? (
              <>
                <label className={LABEL} htmlFor="move-in-transferred-on">
                  {t("moves.transfer.transferredOn")}
                  <input
                    id="move-in-transferred-on"
                    type="date"
                    required
                    value={transferredOn}
                    onChange={(event) => {
                      setTransferredOn(event.target.value);
                    }}
                    className={FIELD_DATA}
                  />
                </label>

                <label className={LABEL} htmlFor="move-in-from-person">
                  {t("moves.transfer.fromPerson")}
                  <select
                    id="move-in-from-person"
                    value={fromPersonId}
                    onChange={(event) => {
                      setFromPersonId(event.target.value);
                    }}
                    className={FIELD}
                  >
                    <option value="">
                      {t("moves.transfer.fromPersonNone")}
                    </option>
                    {holderOptions.map((holder) => (
                      <option key={holder.personId} value={holder.personId}>
                        {holder.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={LABEL} htmlFor="move-in-price">
                  {t("moves.transfer.price")}
                  <input
                    id="move-in-price"
                    type="text"
                    inputMode="decimal"
                    value={price}
                    onChange={(event) => {
                      setPrice(event.target.value);
                    }}
                    className={FIELD_DATA}
                  />
                </label>

                <div className="flex flex-col gap-1">
                  <label className={LABEL} htmlFor="move-in-agreement">
                    {t("moves.transfer.agreementReference")}
                    <input
                      id="move-in-agreement"
                      type="text"
                      value={agreementReference}
                      onChange={(event) => {
                        setAgreementReference(event.target.value);
                      }}
                      className={FIELD}
                    />
                  </label>
                  <p className={HINT}>
                    {t("moves.transfer.agreementReferenceHint")}
                  </p>
                </div>
              </>
            ) : null}

            {failure === null ? null : (
              <Notice tone="danger" live>
                {t(failure)}
              </Notice>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="submit"
                disabled={submitting || person === null}
                className={PRIMARY_BUTTON}
              >
                {submitting ? t("moves.in.working") : t("moves.in.submit")}
              </button>
              <button
                type="button"
                onClick={onClose}
                className={SECONDARY_BUTTON}
              >
                {t("moves.cancel")}
              </button>
            </div>
          </form>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <Notice tone="ok" live>
            {t("moves.in.done", {
              name: person?.name ?? "",
              apartment: apartmentNumber,
            })}
          </Notice>
          {result.memberRegisterEntryRecorded ? (
            <p className="text-small text-ink-muted">
              {t("moves.in.registerEntry")}
            </p>
          ) : null}
          {result.transferId === null ? null : (
            <p className="text-small text-ink-muted">
              {t("moves.transfer.recorded")}
            </p>
          )}
          <p className="text-small text-ink-muted">
            {result.welcomeEmailSent
              ? t("moves.in.welcomeSent")
              : t("moves.in.welcomeSkipped")}
          </p>
          <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
            {t("register.person.close")}
          </button>
        </div>
      )}
    </aside>
  );
}
