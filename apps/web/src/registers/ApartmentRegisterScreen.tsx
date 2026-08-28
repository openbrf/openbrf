import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { SignChip } from "../register/SignChip";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
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
  type ApartmentRegisterExtract,
  type ApartmentRegisterRow,
  fetchApartmentRegister,
  fetchOwnApartmentRegister,
  noteLien,
  releaseLien,
  revealApartmentRegister,
  revealOwnApartmentRegister,
} from "./registers-api";

/**
 * The apartment register (lagenhetsforteckning, BRL 9 kap.).
 *
 * Confidential, and its own screen: the board reads the whole register, and a
 * tenant-owner reads their own entry and nobody else's. Which of the two this
 * is comes from the server, not from a prop - the screen asks for the board's
 * register first and takes a refusal as the answer that the viewer is a
 * tenant-owner, the same rule the address book follows.
 *
 * Personal identity numbers arrive masked. Producing the full statutory extract
 * is a second, deliberate request, and the screen says plainly that the copy it
 * returns is written to the audit log with the reader's name.
 */

type Audience = "board" | "holder";

/** What one load of the register came back with. */
type LoadedExtract =
  | { state: "ok"; audience: Audience; extract: ApartmentRegisterExtract }
  | { state: "failed" };

/**
 * Fetches whichever of the two registers the viewer is entitled to.
 *
 * The board's register first, and a refusal is the server saying this viewer is
 * a tenant-owner rather than a board member. That costs one refused request and
 * buys the property that matters: the server stays the only authority on who
 * reads a confidential register. A client-side guess from the session would be
 * a second opinion that could disagree.
 */
async function loadExtract(): Promise<LoadedExtract> {
  const board = await fetchApartmentRegister();
  if (board.ok) {
    return { state: "ok", audience: "board", extract: board.value };
  }
  if (board.failure.status !== 403) {
    return { state: "failed" };
  }

  const own = await fetchOwnApartmentRegister();
  return own.ok
    ? { state: "ok", audience: "holder", extract: own.value }
    : { state: "failed" };
}

interface LienDraft {
  apartmentId: string;
  creditor: string;
  notedOn: string;
  amount: string;
}

const EMPTY_DRAFT: LienDraft = {
  apartmentId: "",
  creditor: "",
  notedOn: "",
  amount: "",
};

export function ApartmentRegisterScreen(): ReactElement {
  const { t } = useTranslation();
  const [extract, setExtract] = useState<ApartmentRegisterExtract | null>(null);
  const [audience, setAudience] = useState<Audience>("board");
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revealing, setRevealing] = useState(false);
  const [revealFailed, setRevealFailed] = useState(false);
  const [draft, setDraft] = useState<LienDraft | null>(null);
  const [lienFailed, setLienFailed] = useState(false);

  /*
   * Nothing is written to state before an answer arrives, so a reload leaves
   * the document that is already on screen in place rather than blanking it -
   * and the reader of a register extract is usually about to print it.
   */
  const apply = useCallback((loaded: LoadedExtract): void => {
    setFailed(loaded.state === "failed");
    setLoading(false);
    if (loaded.state === "ok") {
      setAudience(loaded.audience);
      setExtract(loaded.extract);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const loaded = await loadExtract();
      if (!cancelled) {
        apply(loaded);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apply]);

  const load = useCallback(async (): Promise<void> => {
    apply(await loadExtract());
  }, [apply]);

  const reveal = useCallback(async (): Promise<void> => {
    setRevealing(true);
    setRevealFailed(false);
    const result =
      audience === "board"
        ? await revealApartmentRegister()
        : await revealOwnApartmentRegister();
    if (result.ok) {
      setExtract(result.value);
    } else {
      setRevealFailed(true);
    }
    setRevealing(false);
  }, [audience]);

  const submitLien = useCallback(
    async (input: LienDraft): Promise<void> => {
      setLienFailed(false);
      const result = await noteLien({
        apartmentId: input.apartmentId,
        creditor: input.creditor.trim(),
        notedOn: input.notedOn,
        amount: input.amount.trim() === "" ? null : input.amount.trim(),
      });
      if (!result.ok) {
        setLienFailed(true);
        return;
      }
      setDraft(null);
      await load();
    },
    [load],
  );

  const release = useCallback(
    async (lienId: string, releasedOn: string): Promise<void> => {
      setLienFailed(false);
      const result = await releaseLien({ lienId, releasedOn });
      if (!result.ok) {
        setLienFailed(true);
        return;
      }
      await load();
    },
    [load],
  );

  const isBoard = audience === "board";

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 print:hidden">
        <div className="flex flex-col gap-2">
          <h1 className="text-display">
            {isBoard
              ? t("registers.apartment.heading")
              : t("registers.apartment.ownHeading")}
          </h1>
          <p className="max-w-2xl text-body text-ink-muted">
            {isBoard
              ? t("registers.apartment.description")
              : t("registers.apartment.ownDescription")}
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            window.print();
          }}
          className={SECONDARY_BUTTON}
        >
          {t("registers.common.print")}
        </button>
      </header>

      <div className="flex flex-col gap-3 print:hidden">
        <p className={HINT}>{t("registers.common.printHint")}</p>

        {extract?.identityNumbersIncluded === true ? (
          <Notice tone="warn" live>
            {t("registers.apartment.identity.included")}
          </Notice>
        ) : (
          <Notice tone="info">
            {t("registers.apartment.identity.notice")}
          </Notice>
        )}

        {extract === null || extract.identityNumbersIncluded ? null : (
          <button
            type="button"
            onClick={() => {
              void reveal();
            }}
            disabled={revealing}
            className={SECONDARY_BUTTON}
          >
            {revealing
              ? t("registers.apartment.identity.including")
              : t("registers.apartment.identity.include")}
          </button>
        )}

        {extract?.identityNumbersIncluded === true ? (
          <button
            type="button"
            onClick={() => {
              void load();
            }}
            className={SECONDARY_BUTTON}
          >
            {t("registers.apartment.identity.hide")}
          </button>
        ) : null}

        {revealFailed ? (
          <Notice tone="danger" live>
            {t("registers.apartment.identity.failed")}
          </Notice>
        ) : null}
        {lienFailed ? (
          <Notice tone="danger" live>
            {t("registers.apartment.liens.failed")}
          </Notice>
        ) : null}
      </div>

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
            <p className="text-title">{t("registers.apartment.heading")}</p>
          </header>

          {extract.rows.length === 0 ? (
            <div className="flex flex-col gap-1">
              <p className="text-title">
                {t("registers.apartment.empty.title")}
              </p>
              <p className="text-body text-ink-muted">
                {isBoard
                  ? t("registers.apartment.empty.description")
                  : t("registers.apartment.ownEmpty")}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {extract.rows.map((row) => (
                <ApartmentEntry
                  key={row.apartmentId}
                  row={row}
                  canWrite={isBoard}
                  draft={draft?.apartmentId === row.apartmentId ? draft : null}
                  onStartLien={() => {
                    setDraft({ ...EMPTY_DRAFT, apartmentId: row.apartmentId });
                  }}
                  onCancelLien={() => {
                    setDraft(null);
                  }}
                  onChangeLien={setDraft}
                  onSubmitLien={(input) => {
                    void submitLien(input);
                  }}
                  onRelease={(lienId, releasedOn) => {
                    void release(lienId, releasedOn);
                  }}
                />
              ))}
            </div>
          )}

          <footer className="border-t border-line pt-4">
            <p className={STAMP}>
              {t("registers.apartment.stamp", {
                scope: t("registers.apartment.scopeAll"),
                date: extract.generatedOn,
              })}
            </p>
          </footer>
        </section>
      )}
    </div>
  );
}

/** One apartment's entry: the designation, its holders, its liens, its transfers. */
function ApartmentEntry({
  row,
  canWrite,
  draft,
  onStartLien,
  onCancelLien,
  onChangeLien,
  onSubmitLien,
  onRelease,
}: {
  row: ApartmentRegisterRow;
  canWrite: boolean;
  draft: LienDraft | null;
  onStartLien: () => void;
  onCancelLien: () => void;
  onChangeLien: (draft: LienDraft) => void;
  onSubmitLien: (draft: LienDraft) => void;
  onRelease: (lienId: string, releasedOn: string) => void;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <article className="flex break-inside-avoid flex-col gap-3 border-t border-line pt-4">
      <h3 className="font-data text-title">{row.designation}</h3>

      <dl className="flex flex-wrap gap-x-8 gap-y-1">
        <Pair
          label={t("registers.apartment.column.initialShareCapital")}
          value={row.initialShareCapital}
        />
        <Pair
          label={t("registers.apartment.column.participationShare")}
          value={row.participationShare}
        />
      </dl>

      <section className="flex flex-col gap-1">
        <h4 className="text-label text-ink-muted uppercase">
          {t("registers.apartment.column.holder")}
        </h4>
        {row.holders.length === 0 ? (
          <p className="text-body text-ink-muted">
            {t("registers.apartment.noHolders")}
          </p>
        ) : (
          <div className={TABLE_SCROLL}>
            <table className={TABLE}>
              <thead>
                <tr>
                  <th scope="col" className={HEAD_CELL}>
                    {t("registers.apartment.column.holder")}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t("registers.apartment.column.personalIdentityNumber")}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t("registers.apartment.column.heldFrom")}
                  </th>
                  <th scope="col" className={HEAD_CELL}>
                    {t("registers.apartment.column.heldUntil")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {row.holders.map((holder) => (
                  <tr
                    key={`${holder.personId}-${holder.heldFrom}`}
                    className={ROW}
                  >
                    <td className={`${CELL} text-body text-ink`}>
                      <span className="flex flex-wrap items-center gap-2">
                        {holder.name}
                        {holder.protectedPersonalData ? (
                          <SignChip sign="PROTECTED" />
                        ) : null}
                      </span>
                    </td>
                    <td className={DATA_CELL}>
                      {holder.personalIdentityNumber.state === "visible" ? (
                        (holder.personalIdentityNumber.value ??
                        t("registers.apartment.identity.notOnFile"))
                      ) : holder.personalIdentityNumber.hasValue ? (
                        <span className="text-warn">
                          {t("registers.apartment.identity.masked")}
                        </span>
                      ) : (
                        t("registers.apartment.identity.notOnFile")
                      )}
                    </td>
                    <td className={DATA_CELL}>{holder.heldFrom}</td>
                    <td className={DATA_CELL}>{holder.heldUntil ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-label text-ink-muted uppercase">
          {t("registers.apartment.liens.heading")}
        </h4>
        {row.liens.length === 0 ? (
          <p className="text-body text-ink-muted">
            {t("registers.apartment.liens.none")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {row.liens.map((lien) => (
              <li
                key={lien.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2"
              >
                <span className="text-body text-ink">{lien.creditor}</span>
                <span className="font-data text-data text-ink-muted">
                  {`${t("registers.apartment.liens.notedOn")} ${lien.notedOn}`}
                </span>
                {lien.amount === null ? null : (
                  <span className="font-data text-data text-ink-muted">
                    {`${t("registers.apartment.liens.amount")} ${lien.amount}`}
                  </span>
                )}
                {lien.releasedOn === null ? (
                  canWrite ? (
                    <button
                      type="button"
                      onClick={() => {
                        onRelease(lien.id, today());
                      }}
                      aria-label={t("registers.apartment.liens.releaseLabel", {
                        creditor: lien.creditor,
                      })}
                      className={`${QUIET_BUTTON} print:hidden`}
                    >
                      {t("registers.apartment.liens.release")}
                    </button>
                  ) : null
                ) : (
                  <span className="font-data text-data text-ink-muted">
                    {`${t("registers.apartment.liens.releasedOn")} ${lien.releasedOn}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {canWrite && draft === null ? (
          <button
            type="button"
            onClick={onStartLien}
            className={`${QUIET_BUTTON} self-start print:hidden`}
          >
            {t("registers.apartment.liens.add")}
          </button>
        ) : null}

        {draft === null ? null : (
          <form
            className="flex flex-col gap-3 rounded-control border border-line p-4 print:hidden"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmitLien(draft);
            }}
          >
            <label className={LABEL}>
              {t("registers.apartment.liens.creditor")}
              <input
                type="text"
                required
                value={draft.creditor}
                onChange={(event) => {
                  onChangeLien({ ...draft, creditor: event.target.value });
                }}
                className={FIELD}
              />
            </label>
            <label className={LABEL}>
              {t("registers.apartment.liens.notedOn")}
              <input
                type="date"
                required
                value={draft.notedOn}
                onChange={(event) => {
                  onChangeLien({ ...draft, notedOn: event.target.value });
                }}
                className={FIELD_DATA}
              />
            </label>
            <label className={LABEL}>
              {t("registers.apartment.liens.amount")}
              <input
                type="text"
                inputMode="decimal"
                value={draft.amount}
                onChange={(event) => {
                  onChangeLien({ ...draft, amount: event.target.value });
                }}
                className={FIELD_DATA}
              />
            </label>
            <div className="flex flex-wrap gap-3">
              <button type="submit" className={PRIMARY_BUTTON}>
                {t("registers.apartment.liens.submit")}
              </button>
              <button
                type="button"
                onClick={onCancelLien}
                className={SECONDARY_BUTTON}
              >
                {t("registers.apartment.liens.cancel")}
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-label text-ink-muted uppercase">
          {t("registers.apartment.transfers.heading")}
        </h4>
        {row.transfers.length === 0 ? (
          <p className="text-body text-ink-muted">
            {t("registers.apartment.transfers.none")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {row.transfers.map((transfer) => (
              <li
                key={transfer.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2"
              >
                <span className="font-data text-data text-ink">
                  {transfer.transferredOn}
                </span>
                <span className="text-body text-ink">
                  {`${transfer.fromName ?? t("registers.apartment.transfers.firstGrant")} → ${transfer.toName}`}
                </span>
                {transfer.price === null ? null : (
                  <span className="font-data text-data text-ink-muted">
                    {`${t("registers.apartment.transfers.price")} ${transfer.price}`}
                  </span>
                )}
                {transfer.agreementReference === null ? (
                  // Named rather than left blank. A reference is required of
                  // every transfer, so a row without one is a gap in a
                  // statutory document, and a board reading the extract has to
                  // see that rather than an empty space where it would be.
                  <span className="text-small text-warn">
                    {t("registers.apartment.transfers.noAgreement")}
                  </span>
                ) : (
                  <span className="font-data text-data text-ink-muted">
                    {`${t("registers.apartment.transfers.agreement")} ${transfer.agreementReference}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

function Pair({
  label,
  value,
}: {
  label: string;
  value: string | null;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-label text-ink-muted uppercase">{label}</dt>
      <dd className="font-data text-data text-ink">
        {value ?? t("registers.common.notRecorded")}
      </dd>
    </div>
  );
}

/**
 * Today as an ISO calendar date, which is what a release date defaults to.
 *
 * Built from the local year, month and day rather than sliced off the UTC
 * instant. Sweden runs an hour or two ahead of UTC, so a release recorded
 * between local midnight and 02:00 would otherwise be stored a day early - and
 * that value is the statutory release date on a row the database will not let
 * anyone delete.
 */
function today(): string {
  const now = new Date();
  return [
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}
