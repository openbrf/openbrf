import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { TranslationKey } from "../i18n/translation-key";
import { DatePair } from "./DatePair";
import { SignChip } from "./SignChip";
import {
  type ApartmentDetail,
  type ApartmentResidency,
  fetchApartment,
} from "./register-api";
import { usePanelHeadingFocus } from "./use-panel-heading-focus";

/**
 * One apartment, as the address book shows it.
 *
 * Residents, residency history and the participation share (andelstal), which
 * drives fee allocation. Deliberately no lien notes and no initial share capital:
 * those are apartment register content (lagenhetsforteckning, BRL 9 kap.), a
 * separate confidential document with its own view and its own access rule - the
 * board, plus each tenant-owner's own entry. The notice at the foot of the panel
 * says so, because a board member who does not find a lien here should know where
 * it lives rather than conclude there is none.
 */

const ROLE_LABEL = {
  MEMBER: "register.sign.member",
  RESIDENT: "register.sign.resident",
} as const satisfies Record<string, TranslationKey>;

function ResidentRow({
  residency,
  onOpenPerson,
}: {
  residency: ApartmentResidency;
  onOpenPerson: (personId: string) => void;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <li className="flex flex-col gap-1 border-t border-line pt-2">
      <button
        type="button"
        onClick={() => {
          onOpenPerson(residency.personId);
        }}
        className="flex min-h-11 items-center text-left text-body font-medium text-ink underline-offset-4 hover:underline"
      >
        {residency.name}
      </button>
      <span className="flex flex-wrap items-center gap-2">
        {residency.protectedPersonalData ? <SignChip sign="PROTECTED" /> : null}
        {residency.role === null ? null : (
          <span className="inline-flex h-5.5 items-center rounded-control bg-sunken px-2 text-chip text-ink uppercase">
            {t(ROLE_LABEL[residency.role])}
          </span>
        )}
        <DatePair
          from={residency.movedInOn}
          to={residency.movedOutOn}
          fromLabelKey="register.column.movedIn"
          toLabelKey="register.column.movedOut"
        />
      </span>
    </li>
  );
}

export function ApartmentPanel({
  apartmentId,
  onClose,
  onOpenPerson,
}: {
  apartmentId: string;
  onClose: () => void;
  onOpenPerson: (personId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const heading = usePanelHeadingFocus();
  const [apartment, setApartment] = useState<ApartmentDetail | null>(null);
  const [failed, setFailed] = useState(false);

  /*
   * No synchronous reset here: the route remounts this panel when the apartment
   * changes (a key on the element), so the initial state is the reset. Clearing
   * state inside the effect would start a second render for no gain.
   */
  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        setApartment(await fetchApartment(apartmentId, controller.signal));
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
  }, [apartmentId]);

  return (
    <aside
      aria-label={
        apartment === null
          ? t("register.heading")
          : t("register.apartment.heading", { number: apartment.number })
      }
      className="flex flex-col gap-5 rounded-panel border border-line bg-raised p-5 shadow-raised"
    >
      <div className="flex items-start justify-between gap-4">
        {/*
         * The number sits in its own mono span rather than inside the
         * interpolated heading: register identifiers belong in the register face
         * so their digits stay comparable with the rows below.
         */}
        <h2 ref={heading} tabIndex={-1} className="text-headline">
          {apartment === null ? (
            t("register.loading")
          ) : (
            <>
              {t("register.apartment.headingLabel")}{" "}
              <span className="font-data">{apartment.number}</span>
            </>
          )}
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

      {apartment === null ? null : (
        <>
          <p className="font-data text-data text-ink-muted">
            {`${apartment.address.street} ${apartment.address.number}, ${apartment.address.postalCode} ${apartment.address.city}`}
          </p>

          <div className="flex flex-col gap-1">
            <span className="text-label text-ink-muted uppercase">
              {t("register.apartment.participationShare")}
            </span>
            <span className="font-data text-data text-ink">
              {apartment.participationShare ??
                t("register.apartment.noParticipationShare")}
            </span>
          </div>

          <section className="flex flex-col gap-2">
            <h3 className="text-title">{t("register.apartment.residents")}</h3>
            {apartment.residents.length === 0 ? (
              <p className="text-body text-ink-muted">
                {t("register.empty.title")}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {apartment.residents.map((residency) => (
                  <ResidentRow
                    key={residency.residencyId}
                    residency={residency}
                    onOpenPerson={onOpenPerson}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-title">{t("register.apartment.history")}</h3>
            {apartment.history.length === 0 ? (
              <p className="text-body text-ink-muted">
                {t("register.apartment.noHistory")}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {apartment.history.map((residency) => (
                  <ResidentRow
                    key={residency.residencyId}
                    residency={residency}
                    onOpenPerson={onOpenPerson}
                  />
                ))}
              </ul>
            )}
          </section>

          <p className="border-t border-line pt-4 text-small text-ink-muted">
            {t("register.apartment.registerNotice")}
          </p>
        </>
      )}
    </aside>
  );
}
