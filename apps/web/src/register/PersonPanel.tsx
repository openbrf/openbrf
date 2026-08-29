import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement, ReactNode } from "react";

import type { TranslationKey } from "../i18n/translation-key";
import { DatePair } from "./DatePair";
import { SignChip } from "./SignChip";
import {
  type ConsentScope,
  fetchPerson,
  type MaskableField,
  type PersonDetail,
  type PublicationConsent,
  RegisterRequestError,
  revealFields,
  type RevealedFields,
  sendInvitation,
  setProtectedPersonalData,
  setPublicationConsent,
} from "./register-api";
import { usePanelHeadingFocus } from "./use-panel-heading-focus";

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

const CONSENT_SCOPE_LABEL = {
  PHOTO: "register.person.consentScope.photo",
  NAME_ON_SITE: "register.person.consentScope.nameOnSite",
  BOARD_ROSTER: "register.person.consentScope.boardRoster",
} as const satisfies Record<ConsentScope, TranslationKey>;

const CONSENT_STATE_LABEL = {
  granted: "register.person.consentGranted",
  withdrawn: "register.person.consentWithdrawn",
  never: "register.person.consentNever",
} as const satisfies Record<PublicationConsent["state"], TranslationKey>;

const ACCOUNT_LABEL = {
  active: "register.person.accountActive",
  invited: "register.person.accountInvited",
  none: "register.person.accountNone",
} as const satisfies Record<string, TranslationKey>;

/** Where one invitation send has got to. */
type InviteStatus =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "sent" }
  | { kind: "failed"; messageKey: TranslationKey };

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
  /**
   * Opens the move-out flow for one residency. Omitted where there is no such
   * flow to open, which is what keeps this panel usable on its own.
   */
  onMoveOut?: (residency: {
    residencyId: string;
    personName: string;
    apartmentNumber: string;
  }) => void;
}

export function PersonPanel({
  personId,
  onClose,
  onChanged,
  onMoveOut,
}: PersonPanelProps): ReactElement {
  const { t } = useTranslation();
  const heading = usePanelHeadingFocus();
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [revealed, setRevealed] = useState<RevealedFields>({});
  const [revealing, setRevealing] = useState<MaskableField | null>(null);
  const [revealFailed, setRevealFailed] = useState(false);
  const [protectionFailed, setProtectionFailed] = useState(false);
  const [consentFailed, setConsentFailed] = useState(false);
  const [consentSaving, setConsentSaving] = useState<ConsentScope | null>(null);
  const [inviteStatus, setInviteStatus] = useState<InviteStatus>({
    kind: "idle",
  });
  const [invitationExpired, setInvitationExpired] = useState(false);
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
        const detail = await fetchPerson(personId, controller.signal);
        setPerson(detail);
        /*
         * Whether an outstanding invitation has expired is decided here, at the
         * moment the register was read, rather than during a render: a render
         * may not depend on the time it happens to run at, and the API reports
         * an outstanding invitation without filtering on its date. Reading the
         * browser's clock is safe for this one - both states offer the same
         * action, send a new link, so skew changes the wording and never what
         * the board can do.
         */
        setInvitationExpired(
          detail.account.invitationExpiresAt !== null &&
            new Date(detail.account.invitationExpiresAt).getTime() < Date.now(),
        );
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

  /*
   * A failed protection change must not look like a successful one. The call
   * site fires this without awaiting, so an uncaught rejection would leave the
   * button clicked, the panel unchanged and nothing said - and a board member
   * who read that as success would leave a person unmasked in the register, in
   * lists and in later exports, which is the exposure the flag exists to
   * prevent.
   */
  const toggleProtection = useCallback(
    async (next: boolean): Promise<void> => {
      setProtectionFailed(false);
      try {
        await setProtectedPersonalData(personId, next);
      } catch {
        setProtectionFailed(true);
        return;
      }
      setRevealed({});
      setReloadToken((token) => token + 1);
      onChanged();
    },
    [personId, onChanged],
  );

  /*
   * Recording or withdrawing one publication consent.
   *
   * `onChanged` is deliberately not called, for the reason the invitation
   * below gives: the board's rows carry no consent state, so reloading them
   * would shift the list under whoever is reading it and change nothing they
   * can see. The panel refetches itself, which is what puts the new date on
   * screen.
   *
   * A failure must not look like success. A board member who read a failed
   * withdrawal as a successful one would leave a person's name publishable
   * after they asked for it to be taken down, which is the whole point of
   * recording the consent in the first place.
   */
  const changeConsent = useCallback(
    async (scope: ConsentScope, granted: boolean): Promise<void> => {
      setConsentFailed(false);
      setConsentSaving(scope);
      try {
        await setPublicationConsent(personId, scope, granted);
      } catch {
        setConsentFailed(true);
        return;
      } finally {
        setConsentSaving(null);
      }
      setReloadToken((token) => token + 1);
    },
    [personId],
  );

  /*
   * Sending an invitation, and sending one again.
   *
   * `onChanged` is deliberately not called: the board's rows carry no account
   * state, so reloading them would shift the list under whoever is reading it
   * and change nothing they can see. The panel refetches itself instead, which
   * is what turns "send an invitation" into "send it again" and puts the new
   * expiry date on screen.
   *
   * An instance whose setup skipped the email settings answers this with
   * mail-not-configured, and that failure gets its own sentence: nothing is
   * wrong with the person or the invitation, and the fix is in settings.
   */
  const invite = useCallback(async (): Promise<void> => {
    setInviteStatus({ kind: "working" });
    try {
      await sendInvitation(personId);
    } catch (error) {
      setInviteStatus({
        kind: "failed",
        messageKey:
          error instanceof RegisterRequestError &&
          error.reason === "mail-not-configured"
            ? "register.person.inviteMailNotConfigured"
            : "register.person.inviteFailed",
      });
      return;
    }
    setInviteStatus({ kind: "sent" });
    setReloadToken((token) => token + 1);
  }, [personId]);

  /*
   * Three states, not two: not revealed yet, revealed with the register holding
   * nothing, and revealed with a value. Without the middle one an empty reveal
   * renders as a blank mono value - a placeholder shaped like a value, which is
   * the one thing MaskedValue exists not to do - and leaves the reveal button in
   * place for a field the register does not hold, so every further click writes
   * another audit entry for nothing. The masked payload carries no presence flag
   * for the postal address, so the completed reveal is what settles it.
   */
  const revealedPostalAddress =
    revealed.postalAddress === undefined
      ? undefined
      : [
          revealed.postalAddress?.street ?? null,
          revealed.postalAddress?.postalCode ?? null,
          revealed.postalAddress?.city ?? null,
        ]
          .filter((part): part is string => part !== null)
          .join(", ");

  /*
   * Whether the register holds an address to send an invitation to. The masked
   * payload carries the presence flag rather than the value, which is exactly
   * the question here and all of it.
   */
  const hasEmailOnFile =
    person !== null &&
    (person.contact.state === "visible"
      ? person.contact.email !== null
      : person.contact.hasEmail);

  /*
   * Read off the invited state rather than off the date alone, so the account
   * field describes one state at a time: an expiry under an active account
   * would be a line about an invitation nobody is waiting for.
   */
  const invitationExpiresAt =
    person !== null && person.account.state === "invited"
      ? person.account.invitationExpiresAt
      : null;

  /*
   * An active account needs nothing. A person the register holds no address
   * for has nowhere to receive an invitation, so they get the reason rather
   * than a button that could only fail. An outstanding invitation is always
   * re-sendable, expired or not: a lost email is the ordinary case, and the API
   * supersedes the previous link rather than leaving two of them alive.
   */
  const inviteOffered =
    person !== null &&
    (person.account.state === "invited" ||
      (person.account.state === "none" && hasEmailOnFile));

  return (
    <aside
      aria-label={t("register.heading")}
      className="flex flex-col gap-5 rounded-panel border border-line bg-raised p-5 shadow-raised"
    >
      <div className="flex items-start justify-between gap-4">
        <h2 ref={heading} tabIndex={-1} className="text-headline">
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
        <p role="alert" className="text-body text-danger">
          {t("register.error.title")}
        </p>
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
                  // A reveal that came back empty is a definitive absence:
                  // nothing to show, and no reason to ask a second time.
                  present={revealedPostalAddress !== ""}
                  value={revealedPostalAddress ?? null}
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
            <p role="alert" className="text-small text-danger">
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
                      <DatePair
                        from={residency.movedInOn}
                        to={residency.movedOutOn}
                        fromLabelKey="register.column.movedIn"
                        toLabelKey="register.column.movedOut"
                      />
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
                    {/*
                     * Moving out is offered per residency rather than per
                     * person: someone holding two apartments sells one of them,
                     * and the member register entry depends on which.
                     */}
                    {residency.movedOutOn === null &&
                    onMoveOut !== undefined ? (
                      <button
                        type="button"
                        onClick={() => {
                          onMoveOut({
                            residencyId: residency.residencyId,
                            personName:
                              `${person.firstName} ${person.lastName}`.trim(),
                            apartmentNumber: `${residency.addressLabel} ${residency.apartmentNumber}`,
                          });
                        }}
                        aria-label={t("moves.out.actionLabel", {
                          apartment: residency.apartmentNumber,
                        })}
                        className={`${SECONDARY_BUTTON} self-start`}
                      >
                        {t("moves.out.action")}
                      </button>
                    ) : null}
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
                    <DatePair
                      from={position.electedOn}
                      to={position.endedOn}
                      fromLabelKey="register.person.electedOn"
                      toLabelKey="register.person.endedOn"
                    />
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
            <span className="flex flex-col items-start gap-2">
              <span className="text-body text-ink">
                {t(ACCOUNT_LABEL[person.account.state])}
              </span>
              {person.account.twoFactorEnabled ? (
                <span className="text-small text-ink-muted">
                  {t("register.person.twoFactor")}
                </span>
              ) : null}

              {/*
               * The date the link stops working, on the mono grid like every
               * other register date. The API sends a timestamp; the day is what
               * the board acts on.
               */}
              {invitationExpiresAt === null ? null : (
                <span className="font-data text-data text-ink">
                  {`${t("register.person.invitationExpiresAt")} ${invitationExpiresAt.slice(0, 10)}`}
                </span>
              )}
              {invitationExpiresAt !== null && invitationExpired ? (
                <span className="text-small text-warn">
                  {t("register.person.invitationExpired")}
                </span>
              ) : null}

              {person.account.state === "none" && !hasEmailOnFile ? (
                <span className="text-small text-ink-muted">
                  {t("register.person.inviteNoEmail")}
                </span>
              ) : null}

              {inviteOffered ? (
                <button
                  type="button"
                  onClick={() => {
                    void invite();
                  }}
                  disabled={inviteStatus.kind === "working"}
                  className={`${SECONDARY_BUTTON} disabled:opacity-60`}
                >
                  {inviteStatus.kind === "working"
                    ? t("register.person.inviteWorking")
                    : person.account.state === "invited"
                      ? t("register.person.inviteAgain")
                      : t("register.person.invite")}
                </button>
              ) : null}

              {inviteStatus.kind === "sent" ? (
                <span role="status" className="text-small text-ok">
                  {t("register.person.inviteSent")}
                </span>
              ) : null}
              {inviteStatus.kind === "failed" ? (
                <span role="alert" className="text-small text-danger">
                  {t(inviteStatus.messageKey)}
                </span>
              ) : null}
            </span>
          </Field>

          {/*
           * Publication consent, on the board's person view and nowhere else.
           * This is the board's record of what the person told them - the same
           * kind of note as the protected-data flag below - so it belongs where
           * the board works, not on a screen a resident reads about themselves.
           */}
          <section className="flex flex-col gap-3 border-t border-line pt-4">
            <h3 className="text-title">
              {t("register.person.publicationConsent")}
            </h3>
            <p className="text-small text-ink-muted">
              {t("register.person.publicationConsentExplained")}
            </p>
            <ul className="flex flex-col gap-3">
              {person.publicationConsents.map((consent) => (
                <li
                  key={consent.scope}
                  className="flex flex-col gap-1.5 border-t border-line pt-2"
                >
                  <span className="text-label text-ink-muted uppercase">
                    {t(CONSENT_SCOPE_LABEL[consent.scope])}
                  </span>
                  <span className="text-body text-ink">
                    {t(CONSENT_STATE_LABEL[consent.state])}
                  </span>
                  <DatePair
                    from={consent.grantedOn}
                    to={consent.withdrawnOn}
                    fromLabelKey="register.person.consentGrantedOn"
                    toLabelKey="register.person.consentWithdrawnOn"
                  />
                  {consent.note === null ? null : (
                    <span className="text-small text-ink-muted">
                      {consent.note}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      void changeConsent(
                        consent.scope,
                        consent.state !== "granted",
                      );
                    }}
                    disabled={consentSaving !== null}
                    aria-label={t(
                      consent.state === "granted"
                        ? "register.person.consentWithdrawLabel"
                        : "register.person.consentRecordLabel",
                      { scope: t(CONSENT_SCOPE_LABEL[consent.scope]) },
                    )}
                    className={`${
                      consent.state === "granted"
                        ? CAUTION_BUTTON
                        : SECONDARY_BUTTON
                    } self-start disabled:opacity-60`}
                  >
                    {consentSaving === consent.scope
                      ? t("register.person.consentWorking")
                      : consent.state === "granted"
                        ? t("register.person.consentWithdraw")
                        : t("register.person.consentRecord")}
                  </button>
                </li>
              ))}
            </ul>
            {consentFailed ? (
              <p role="alert" className="text-small text-danger">
                {t("register.person.consentFailed")}
              </p>
            ) : null}
          </section>

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
            {protectionFailed ? (
              <p role="alert" className="text-small text-danger">
                {t("register.person.protectionFailed")}
              </p>
            ) : null}
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
        aria-label={t("register.reveal.ariaLabel", {
          field: t(FIELD_LABEL[field]),
        })}
        className={`${CAUTION_BUTTON} disabled:opacity-60`}
      >
        {revealing ? t("register.reveal.working") : t("register.reveal.action")}
      </button>
    </span>
  );
}
