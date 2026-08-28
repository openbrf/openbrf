import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import {
  CELL,
  DATA_CELL,
  DOCUMENT,
  DOCUMENT_ATTRIBUTE,
  HEAD_CELL,
  ROW,
  STAMP,
  TABLE,
  TABLE_SCROLL,
} from "./document";
import {
  fetchMemberRegister,
  type MemberRegisterExtract,
  type MemberRegisterRow,
  type MemberRegisterScope,
} from "./registers-api";

/**
 * The member register (medlemsforteckning, EFL 5 kap. via BRL 9 kap.).
 *
 * Its own screen, reached by its own route, showing its own field list: name,
 * postal address, the apartment the membership relates to, and the dates the
 * membership began and ended. Nothing else, and in particular no personal
 * identity number - this extract is public on request, so the register may not
 * carry one and this screen has nowhere to put one.
 *
 * The apartment register is a different document under a different rule and has
 * a different screen. They are never shown together, which is why there is no
 * shared component rendering either.
 */

const SCOPES: readonly MemberRegisterScope[] = ["current", "all"];

/**
 * The address the extract prints.
 *
 * A protected member's address is what protection exists to withhold, so the
 * document says it is protected rather than leaving the cell blank: a gap reads
 * as a register that lost the address.
 *
 * The row's own protected flag decides, not only the shape the server sent.
 * Masking is a server-side contract and this screen is not what enforces it,
 * but this extract is public on request: if a protected member's row ever
 * arrived carrying a visible address, printing it would be the one mistake on
 * this screen that cannot be taken back once the paper is handed over.
 */
function postalAddress(row: MemberRegisterRow, maskedLabel: string): string {
  if (row.protectedPersonalData || row.postalAddress.state === "masked") {
    return row.postalAddress.state === "masked"
      ? (row.postalAddress.alternativePostalAddress ?? maskedLabel)
      : maskedLabel;
  }
  return (
    [
      row.postalAddress.street,
      row.postalAddress.postalCode,
      row.postalAddress.city,
    ]
      .filter((part): part is string => part !== null && part !== "")
      .join(", ") || "-"
  );
}

export function MemberRegisterScreen(): ReactElement {
  const { t } = useTranslation();
  const [scope, setScope] = useState<MemberRegisterScope>("current");
  const [extract, setExtract] = useState<MemberRegisterExtract | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  /*
   * The previous extract stays on screen while the next one loads, so changing
   * what is shown does not blank the document. Nothing is written to state
   * before the answer arrives, which is also what keeps a request that was
   * superseded from clearing the extract that is already on the page.
   */
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await fetchMemberRegister(scope);
      if (cancelled) {
        return;
      }
      setFailed(!result.ok);
      if (result.ok) {
        setExtract(result.value);
      }
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [scope]);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 print:hidden">
        <div className="flex flex-col gap-2">
          <h1 className="text-display">{t("registers.member.heading")}</h1>
          <p className="max-w-2xl text-body text-ink-muted">
            {t("registers.member.description")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <fieldset className="flex items-center gap-3">
            <legend className="sr-only">
              {t("registers.member.scope.label")}
            </legend>
            {SCOPES.map((candidate) => (
              <label
                key={candidate}
                className="flex min-h-11 items-center gap-2 text-small text-ink"
              >
                <input
                  type="radio"
                  name="member-register-scope"
                  value={candidate}
                  checked={scope === candidate}
                  onChange={() => {
                    setScope(candidate);
                  }}
                  className="size-4 accent-trust"
                />
                {t(`registers.member.scope.${candidate}`)}
              </label>
            ))}
          </fieldset>

          <button
            type="button"
            onClick={() => {
              window.print();
            }}
            className={SECONDARY_BUTTON}
          >
            {t("registers.common.print")}
          </button>
        </div>
      </header>

      <p className="text-small text-ink-muted print:hidden">
        {t("registers.common.printHint")}
      </p>

      {failed ? (
        <Notice tone="danger" live>
          {t("registers.common.error")}
        </Notice>
      ) : null}

      {loading && extract === null ? (
        <p role="status" className="text-body text-ink-muted">
          {t("registers.common.loading")}
        </p>
      ) : null}

      {extract === null ? null : (
        <section {...DOCUMENT_ATTRIBUTE} className={DOCUMENT}>
          <header className="flex flex-col gap-1">
            <h2 className="text-headline">{extract.housingCooperative.name}</h2>
            {extract.housingCooperative.organizationNumber === null ? null : (
              <p className="font-data text-data text-ink-muted">
                {`${t("registers.common.organizationNumber")} ${extract.housingCooperative.organizationNumber}`}
              </p>
            )}
            <p className="text-title">{t("registers.member.heading")}</p>
          </header>

          {/*
           * Said out loud on the document itself. Somebody handed this extract
           * should be able to see that the absence of an identity number is the
           * rule rather than a gap in the register.
           */}
          <p className="text-small text-ink-muted">
            {t("registers.member.noIdentityNumbers")}
          </p>

          {extract.rows.length === 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-title">{t("registers.member.empty.title")}</p>
              <p className="text-body text-ink-muted">
                {t("registers.member.empty.description")}
              </p>
            </div>
          ) : (
            <div className={TABLE_SCROLL}>
              <table className={TABLE}>
                <caption className="sr-only">
                  {t("registers.member.heading")}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className={HEAD_CELL}>
                      {t("registers.member.column.name")}
                    </th>
                    <th scope="col" className={HEAD_CELL}>
                      {t("registers.member.column.postalAddress")}
                    </th>
                    <th scope="col" className={HEAD_CELL}>
                      {t("registers.member.column.apartment")}
                    </th>
                    <th scope="col" className={HEAD_CELL}>
                      {t("registers.member.column.enteredOn")}
                    </th>
                    <th scope="col" className={HEAD_CELL}>
                      {t("registers.member.column.exitedOn")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {extract.rows.map((row) => (
                    <tr key={row.key} className={ROW}>
                      <td className={`${CELL} text-body text-ink`}>
                        {row.name}
                      </td>
                      <td className={DATA_CELL}>
                        {postalAddress(
                          row,
                          t("registers.member.maskedAddress"),
                        )}
                      </td>
                      <td className={DATA_CELL}>
                        {row.apartments.length === 0
                          ? "-"
                          : row.apartments
                              .map(
                                (apartment) =>
                                  `${apartment.addressLabel} ${apartment.number}`,
                              )
                              .join(", ")}
                      </td>
                      <td className={DATA_CELL}>{row.enteredOn ?? "-"}</td>
                      <td className={DATA_CELL}>{row.exitedOn ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className={STAMP}>
              {`${t("registers.member.count")} ${String(extract.rows.length)}`}
            </p>
            <p className={STAMP}>
              {t("registers.member.stamp", {
                scope: t(`registers.member.scopeName.${extract.scope}`),
                date: extract.generatedOn,
              })}
            </p>
          </footer>
        </section>
      )}
    </div>
  );
}
