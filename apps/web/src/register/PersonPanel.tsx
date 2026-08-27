import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement, ReactNode } from "react";

import type { TranslationKey } from "../i18n/translation-key";
import { SignChip } from "./SignChip";
import {
  fetchPerson,
  type MaskableField,
  type PersonDetail,
  revealFields,
  type RevealedFields,
  setProtectedPersonalData,
} from "./register-api";

/**
 * One person, as the board sees them.
 *
 * Masked fields arrive masked and stay masked until someone asks. The reveal is a
 * deliberate click, never a hover or a page load, because every reveal writes an
 * audit entry naming the person who asked and the fields they saw - the screen
 * says so next to the buttons, so nobody discovers it afterwards.
 *
 * The panel sits in the room on a light surface, not on the board: it is a
 * working view of one person rather than a register extract.
 */

const FIELD_LABEL: Record<MaskableField, TranslationKey> = {
  email: "register.person.email",
  phone: "register.person.phone",
  personalIdentityNumber: "register.person.personalIdentityNumber",
  postalAddress: "register.person.postalAddress",
};

const ROLE_LABEL = {
  MEMBER: "register.sign.member",
  RESIDENT: "register.sign.resident",
} as const satisfies Record<string, TranslationKey>;

const SYSTEM_ROLE_LABEL = {
  ADMIN: "register.person.systemRole.admin",
  PROPERTY_MANAGER: "register.person.systemRole.propertyManager",
} as const satisfies Record<string, TranslationKey>;

const ACCOUNT_LABEL = {
  active: "register.person.accountActive",
  invited: "register.person.accountInvited",
  none: "register.person.accountNone",
} as const satisfies Record<string, TranslationKey>;

const SECONDARY_BUTTON =
  "inline-flex min-h-11 items-center gap-2 rounded-control border border-line-strong bg-raised px-4 text-small font-semibold text-ink";
const CAUTION_BUTTON =
  "inline-flex min-h-11 items-center gap-2 rounded-control border border-line-strong bg-raised px-4 text-small font-semibold text-warn";

/** A label above a value, the room-side pattern for a read-only field. */
function Field({
  labelKey,
  children,
}: {
  labelKey: TranslationKey;
  children: ReactNode;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-1">
      <span className="text-label text-ink-muted uppercase">{t(labelKey)}</span>
      {children}
    </div>
  );
}

/** Register data in the room still belongs in the mono grid. */
function DataValue({ children }: { children: ReactNode }): ReactElement {
  return <span className="font-data text-data text-ink">{children}</span>;
}

export interface PersonPanelProps {
  personId: string;
  onClose: () => void;
  /** Called after a change that the board's rows would show differently. */
  onChanged: () => void;
}

export function PersonPanel({
  personId,
  onClose,
  onChanged,
}: PersonPanelProps): ReactElement {
  const { t } = useTranslation();
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [revealed, setRevealed] = useState<RevealedFields>({});
  const [revealing, setRevealing] = useState<MaskableField | null>(null);
  const [revealFailed, setRevealFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  /*
   * No synchronous reset here: the route remounts this panel when the person
   * changes (a key on the element), so the initial state is the reset. That also
   * settles the thing that matters most - a revealed value belongs to the person
   * it was revealed for, and a remount cannot carry one across to the next.
   */
  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        setPerson(await fetchPerson(personId, controller.signal));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setFailed(true);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [personId, reloadToken]);

  const reveal = useCallback(
    async (field: MaskableField): Promise<void> => {
      setRevealing(field);
      setRevealFailed(false);
      try {
        const result = await revealFields(personId, [field]);
        setRevealed((current) => ({ ...current, ...result }));
      } catch {
        setRevealFailed(true);
      } finally {
        setRevealing(null);
      }
    },
    [personId],
  );

  const hide = useCallback((field: MaskableField): void => {
    setRevealed((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);

  const toggleProtection = useCallback(
    async (next: boolean): Promise<void> => {
      await setProtectedPersonalData(personId, next);
      setRevealed({});
      setReloadToken((token) => token + 1);
      onChanged();
    },
    [personId, onChanged],
  );

  return (
    <aside
      aria-label={t("register.heading")}
      className="flex flex-col gap-5 rounded-panel border border-line bg-raised p-5 shadow-raised"
    >
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-headline">
          {person === null
            ? t("register.loading")
            : `${person.firstName} ${person.lastName}`}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 rounded-control border border-line-strong px-3 text-small font-semibold text-ink"
        >
          {t("register.person.close")}
        </button>
      </div>

      {failed ? (
        <p className="text-body text-danger">{t("register.error.title")}</p>
      ) : null}

      {person === null ? null : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {person.protectedPersonalData ? (
              <SignChip sign="PROTECTED" />
            ) : null}
            {person.boardPositions
              .filter((position) => position.endedOn === null)
              .map((position) => (
                <SignChip key={position.position} sign={position.position} />
              ))}
            <SignChip sign={person.isMember ? "MEMBER" : "RESIDENT"} />
          </div>

          <p className="text-body text-ink-muted">
            {person.isMember
              ? t("register.person.isMember")
              : t("register.person.notMember")}
          </p>

          <section className="flex flex-col gap-4">
            <Field labelKey="register.person.email">
              <MaskedValue
                field="email"
                masked={person.contact.state === "masked"}
                present={
                  person.contact.state === "masked"
                    ? person.contact.hasEmail
                    : person.contact.email !== null
                }
                value={
                  person.contact.state === "visible"
                    ? person.contact.email
                    : (revealed.email ?? null)
                }
                revealing={revealing === "email"}
                onReveal={() => {
                  void reveal("email");
                }}
                onHide={() => {
                  hide("email");
                }}
              />
            </Field>

            <Field labelKey="register.person.phone">
              <MaskedValue
                field="phone"
                masked={person.contact.state === "masked"}
                present={
                  person.contact.state === "masked"
                    ? person.contact.hasPhone
                    : person.contact.phone !== null
                }
                value={
                  person.contact.state === "visible"
                    ? person.contact.phone
                    : (revealed.phone ?? null)
                }
                revealing={revealing === "phone"}
                onReveal={() => {
                  void reveal("phone");
                }}
                onHide={() => {
                  hide("phone");
                }}
              />
            </Field>

            {/*
             * Always masked, protected flag or not: the personal identity number
             * is reachable only through the audited reveal, and never appears in
             * a list.
             */}
            <Field labelKey="register.person.personalIdentityNumber">
              <MaskedValue
                field="personalIdentityNumber"
                masked
                present={person.hasPersonalIdentityNumber}
                value={revealed.personalIdentityNumber ?? null}
                revealing={revealing === "personalIdentityNumber"}
                onReveal={() => {
                  void reveal("personalIdentityNumber");
                }}
                onHide={() => {
                  hide("personalIdentityNumber");
                }}
              />
            </Field>

            <Field labelKey="register.person.postalAddress">
              {person.postalAddress.state === "visible" ? (
                <DataValue>
                  {[
                    person.postalAddress.street,
                    person.postalAddress.postalCode,
                    person.postalAddress.city,
                  ]
                    .filter((part): part is string => part !== null)
                    .join(", ") || t("register.person.notOnFile")}
                </DataValue>
              ) : (
                <MaskedValue
                  field="postalAddress"
                  masked
                  present
                  value={
                    revealed.postalAddress === undefined ||
                    revealed.postalAddress === null
                      ? null
                      : [
                          revealed.postalAddress.street,
                          revealed.postalAddress.postalCode,
                          revealed.postalAddress.city,
                        ]
                          .filter((part): part is string => part !== null)
                          .join(", ")
                  }
                  revealing={revealing === "postalAddress"}
                  onReveal={() => {
                    void reveal("postalAddress");
                  }}
                  onHide={() => {
                    hide("postalAddress");
                  }}
                />
              )}
            </Field>

            {person.postalAddress.state === "masked" ? (
              <Field labelKey="register.person.alternativeAddress">
                <DataValue>
                  {person.postalAddress.alternativePostalAddress ??
                    t("register.person.noAlternativeAddress")}
                </DataValue>
              </Field>
            ) : null}
          </section>

          <p className="text-small text-ink-muted">
            {t("register.reveal.logged")}
          </p>
          {revealFailed ? (
            <p className="text-small text-danger">
              {t("register.reveal.failed")}
            </p>
          ) : null}

          <section className="flex flex-col gap-2">
            <h3 className="text-title">{t("register.person.residencies")}</h3>
            {person.residencies.length === 0 ? (
              <p className="text-body text-ink-muted">
                {t("register.person.noResidencies")}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {person.residencies.map((residency) => (
                  <li
                    key={residency.residencyId}
                    className="flex flex-col gap-1 border-t border-line pt-2"
                  >
                    <DataValue>
                      {`${residency.addressLabel} ${residency.apartmentNumber}`}
                    </DataValue>
                    <span className="flex flex-wrap items-center gap-2">
                      <SignChipRoom labelKey={ROLE_LABEL[residency.role]} />
                      <DataValue>
                        {`${residency.movedInOn ?? ""} ${
                          residency.movedOutOn ?? ""
                        }`.trim()}
                      </DataValue>
                      <span className="text-small text-ink-muted">
                        {residency.movedOutOn === null
                          ? t("register.person.current")
                          : t("register.person.ended")}
                      </span>
                    </span>
                    {residency.purgeOn === null ? null : (
                      <span className="font-data text-data text-warn">
                        {`${t("register.purge.label")} ${residency.purgeOn}`}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {person.boardPositions.length === 0 ? null : (
            <section className="flex flex-col gap-2">
              <h3 className="text-title">
                {t("register.person.boardPositions")}
              </h3>
              <ul className="flex flex-col gap-1">
                {person.boardPositions.map((position) => (
                  <li
                    key={`${position.position}-${position.electedOn ?? ""}`}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <SignChip sign={position.position} />
                    <DataValue>
                      {`${position.electedOn ?? ""} ${
                        position.endedOn ?? ""
                      }`.trim()}
                    </DataValue>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {person.systemRoles.length === 0 ? null : (
            <Field labelKey="register.person.systemRoles">
              <span className="flex flex-wrap gap-2">
                {person.systemRoles.map((role) => (
                  <SignChipRoom key={role} labelKey={SYSTEM_ROLE_LABEL[role]} />
                ))}
              </span>
            </Field>
          )}

          <Field labelKey="register.person.account">
            <span className="flex flex-col gap-1">
              <span className="text-body text-ink">
                {t(ACCOUNT_LABEL[person.account.state])}
              </span>
              {person.account.twoFactorEnabled ? (
                <span className="text-small text-ink-muted">
                  {t("register.person.twoFactor")}
                </span>
              ) : null}
            </span>
          </Field>

          <section className="flex flex-col gap-2 border-t border-line pt-4">
            <h3 className="text-title">{t("register.person.protectedFlag")}</h3>
            <p className="text-small text-ink-muted">
              {person.protectedPersonalData
                ? t("register.person.protectedOn")
                : t("register.person.protectedOff")}
            </p>
            <button
              type="button"
              onClick={() => {
                void toggleProtection(!person.protectedPersonalData);
              }}
              className={
                person.protectedPersonalData ? SECONDARY_BUTTON : CAUTION_BUTTON
              }
            >
              {person.protectedPersonalData
                ? t("register.person.unprotect")
                : t("register.person.protect")}
            </button>
          </section>
        </>
      )}
    </aside>
  );
}

/** A room-side sign, soft-filled per DESIGN.md rather than outlined. */
function SignChipRoom({
  labelKey,
}: {
  labelKey: TranslationKey;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <span className="inline-flex h-5.5 items-center rounded-control bg-sunken px-2 text-chip text-ink uppercase">
      {t(labelKey)}
    </span>
  );
}

/**
 * A field that is masked until someone asks for it.
 *
 * Three states, and each says which one it is in words: not on file, masked, or
 * revealed. Never a row of asterisks - a placeholder shaped like a value reads as
 * "the value is here but hidden", when the truth is that seeing it is a separate
 * act that gets logged.
 */
function MaskedValue({
  field,
  masked,
  present,
  value,
  revealing,
  onReveal,
  onHide,
}: {
  field: MaskableField;
  masked: boolean;
  present: boolean;
  value: string | null;
  revealing: boolean;
  onReveal: () => void;
  onHide: () => void;
}): ReactElement {
  const { t } = useTranslation();

  if (!present) {
    return (
      <span className="text-body text-ink-muted">
        {t("register.person.notOnFile")}
      </span>
    );
  }

  if (!masked) {
    return <DataValue>{value ?? t("register.person.notOnFile")}</DataValue>;
  }

  if (value !== null) {
    return (
      <span className="flex flex-wrap items-center gap-3">
        <DataValue>{value}</DataValue>
        {/*
         * Hiding again is local: no second request and no second audit entry.
         * A revealed personal identity number should not sit on a screen that
         * may be shared for the rest of the session.
         */}
        <button type="button" onClick={onHide} className={SECONDARY_BUTTON}>
          {t("register.reveal.hide")}
        </button>
      </span>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-3">
      <span className="font-data text-data text-warn">
        {t("register.contact.masked")}
      </span>
      <button
        type="button"
        onClick={onReveal}
        disabled={revealing}
        aria-label={`${t("register.reveal.action")}: ${t(FIELD_LABEL[field])}`}
        className={`${CAUTION_BUTTON} disabled:opacity-60`}
      >
        {revealing ? t("register.reveal.working") : t("register.reveal.action")}
      </button>
    </span>
  );
}
