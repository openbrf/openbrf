import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { localDayNow } from "../bookings/booking-calendar";
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
import { NotRecorded } from "../ui/NotRecorded";
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
  type TerminationKind,
  fetchApartmentRegister,
  fetchOwnApartmentRegister,
  noteLien,
  recordMembershipDecision,
  recordPropertyDesignation,
  recordTermination,
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

/** What the board is recording about a tenant-ownership that has ceased. */
interface TerminationDraft {
  apartmentId: string;
  kind: TerminationKind;
  tookEffectOn: string;
  reference: string;
}

/*
 * The general meeting's decision is the opening default because it is the
 * ground a board reaches this form for: the building being disposed of ends
 * every tenant-ownership in it at once and is not an entry a board makes
 * apartment by apartment on an ordinary week.
 */
const EMPTY_TERMINATION: TerminationDraft = {
  apartmentId: "",
  kind: "GENERAL_MEETING_DECISION",
  tookEffectOn: "",
  reference: "",
};

/** The two grounds, in the order the form offers them. */
const TERMINATION_KINDS: TerminationKind[] = [
  "GENERAL_MEETING_DECISION",
  "BUILDING_TRANSFERRED",
];

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
  const [termination, setTermination] = useState<TerminationDraft | null>(null);
  const [terminationFailed, setTerminationFailed] = useState(false);
  // Its own state, not the termination one. Both acts are recorded from this
  // screen and they are different register events with different consequences,
  // so a board told a termination was refused after a membership decision was
  // refused would go looking for the wrong record - and might record the
  // termination again to fix it.
  const [membershipFailed, setMembershipFailed] = useState(false);
  const [designation, setDesignation] = useState<string | null>(null);
  const [designationFailed, setDesignationFailed] = useState(false);

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

  const submitTermination = useCallback(
    async (input: TerminationDraft): Promise<void> => {
      setTerminationFailed(false);
      const result = await recordTermination({
        apartmentId: input.apartmentId,
        kind: input.kind,
        tookEffectOn: input.tookEffectOn,
        reference: input.reference.trim(),
      });
      if (!result.ok) {
        setTerminationFailed(true);
        return;
      }
      setTermination(null);
      await load();
    },
    [load],
  );

  const submitMembershipDecision = useCallback(
    async (transferId: string, membershipDecidedOn: string): Promise<void> => {
      setMembershipFailed(false);
      const result = await recordMembershipDecision({
        transferId,
        membershipDecidedOn,
      });
      if (!result.ok) {
        setMembershipFailed(true);
        return;
      }
      await load();
    },
    [load],
  );

  const submitDesignation = useCallback(
    async (value: string): Promise<void> => {
      setDesignationFailed(false);
      const trimmed = value.trim();
      const result = await recordPropertyDesignation({
        // Cleared rather than stored empty: the register states a designation or
        // says none is recorded, and an empty string is neither.
        propertyDesignation: trimmed === "" ? null : trimmed,
      });
      if (!result.ok) {
        setDesignationFailed(true);
        return;
      }
      setDesignation(null);
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
        {terminationFailed ? (
          <Notice tone="danger" live>
            {t("registers.apartment.terminations.failed")}
          </Notice>
        ) : null}
        {membershipFailed ? (
          <Notice tone="danger" live>
            {t("registers.apartment.transfers.membershipFailed")}
          </Notice>
        ) : null}
        {designationFailed ? (
          <Notice tone="danger" live>
            {t("registers.apartment.designation.failed")}
          </Notice>
        ) : null}

        {/*
          The property designation, recorded here rather than in settings
          because it is register content: it names the property the apartments
          are in, and the cooperative housing register asks the association for
          it. The prose the board publishes to a broker is a separate field,
          and neither is derived from the other.
        */}
        {isBoard && extract !== null ? (
          designation === null ? (
            <button
              type="button"
              onClick={() => {
                setDesignation(
                  extract.housingCooperative.propertyDesignation ?? "",
                );
              }}
              className={QUIET_BUTTON}
            >
              {extract.housingCooperative.propertyDesignation === null
                ? t("registers.apartment.designation.add")
                : t("registers.apartment.designation.edit")}
            </button>
          ) : (
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void submitDesignation(designation);
              }}
            >
              <label className={LABEL}>
                {t("registers.apartment.designation.label")}
                <input
                  type="text"
                  value={designation}
                  maxLength={200}
                  onChange={(event) => {
                    setDesignation(event.target.value);
                  }}
                  className={FIELD}
                />
              </label>
              <button type="submit" className={PRIMARY_BUTTON}>
                {t("registers.apartment.designation.submit")}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDesignation(null);
                }}
                className={SECONDARY_BUTTON}
              >
                {t("registers.apartment.designation.cancel")}
              </button>
            </form>
          )
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
            {extract.housingCooperative.propertyDesignation === null ? null : (
              <p className="font-data text-data text-ink-muted">
                {`${t("registers.apartment.designation.label")} ${extract.housingCooperative.propertyDesignation}`}
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
                  termination={
                    termination?.apartmentId === row.apartmentId
                      ? termination
                      : null
                  }
                  onStartTermination={() => {
                    setTermination({
                      ...EMPTY_TERMINATION,
                      apartmentId: row.apartmentId,
                    });
                  }}
                  onCancelTermination={() => {
                    setTermination(null);
                  }}
                  onChangeTermination={setTermination}
                  onSubmitTermination={(input) => {
                    void submitTermination(input);
                  }}
                  onRecordMembershipDecision={(transferId, decidedOn) => {
                    void submitMembershipDecision(transferId, decidedOn);
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

/**
 * One apartment's entry: the designation, its holders, its liens, its transfers
 * and any tenant-ownership that has ceased.
 */
function ApartmentEntry({
  row,
  canWrite,
  draft,
  onStartLien,
  onCancelLien,
  onChangeLien,
  onSubmitLien,
  onRelease,
  termination,
  onStartTermination,
  onCancelTermination,
  onChangeTermination,
  onSubmitTermination,
  onRecordMembershipDecision,
}: {
  row: ApartmentRegisterRow;
  canWrite: boolean;
  draft: LienDraft | null;
  onStartLien: () => void;
  onCancelLien: () => void;
  onChangeLien: (draft: LienDraft) => void;
  onSubmitLien: (draft: LienDraft) => void;
  onRelease: (lienId: string, releasedOn: string) => void;
  termination: TerminationDraft | null;
  onStartTermination: () => void;
  onCancelTermination: () => void;
  onChangeTermination: (draft: TerminationDraft) => void;
  onSubmitTermination: (draft: TerminationDraft) => void;
  onRecordMembershipDecision: (transferId: string, decidedOn: string) => void;
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
                    <td className={DATA_CELL}>
                      {holder.heldUntil ?? (
                        <NotRecorded
                          meaning={t("registers.apartment.noValue.heldUntil")}
                        />
                      )}
                    </td>
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
                  {t("registers.apartment.transfers.parties", {
                    from:
                      transfer.fromName ??
                      t("registers.apartment.transfers.firstGrant"),
                    to: transfer.toName,
                  })}
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
                {/*
                  The membership decision date, which is the day the register's
                  two-week reporting window opens for this transfer. Shown once
                  recorded, and offered for recording while it is absent -
                  never described as missing, because the statute has transfers
                  with no such decision at all and a register must not call one
                  of those a gap.
                */}
                {transfer.membershipDecidedOn === null ? (
                  canWrite ? (
                    <MembershipDecisionControl
                      transferId={transfer.id}
                      onRecord={onRecordMembershipDecision}
                    />
                  ) : null
                ) : (
                  <span className="font-data text-data text-ink-muted">
                    {`${t("registers.apartment.transfers.membershipDecided")} ${transfer.membershipDecidedOn}`}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-label text-ink-muted uppercase">
          {t("registers.apartment.terminations.heading")}
        </h4>
        {row.terminations.length === 0 ? (
          <p className="text-body text-ink-muted">
            {t("registers.apartment.terminations.none")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {row.terminations.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2"
              >
                <span className="font-data text-data text-ink">
                  {entry.tookEffectOn}
                </span>
                <span className="text-body text-ink">
                  {t(`registers.apartment.terminations.kind.${entry.kind}`)}
                </span>
                <span className="font-data text-data text-ink-muted">
                  {`${t("registers.apartment.terminations.reference")} ${entry.reference}`}
                </span>
              </li>
            ))}
          </ul>
        )}

        {!canWrite ? null : termination === null ? (
          <button
            type="button"
            onClick={onStartTermination}
            className={`${QUIET_BUTTON} self-start print:hidden`}
          >
            {t("registers.apartment.terminations.add")}
          </button>
        ) : (
          <form
            className="flex flex-col gap-3 print:hidden"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmitTermination(termination);
            }}
          >
            <label className={LABEL}>
              {t("registers.apartment.terminations.kindLabel")}
              <select
                value={termination.kind}
                onChange={(event) => {
                  onChangeTermination({
                    ...termination,
                    // The select offers exactly the two grounds, so its value
                    // is one of them; the cast is what carries that from the
                    // DOM's string back into the union.
                    kind: event.target.value as TerminationKind,
                  });
                }}
                className={FIELD}
              >
                {TERMINATION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`registers.apartment.terminations.kind.${kind}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className={LABEL}>
              {t("registers.apartment.terminations.tookEffectOn")}
              <input
                type="date"
                required
                value={termination.tookEffectOn}
                max={today()}
                onChange={(event) => {
                  onChangeTermination({
                    ...termination,
                    tookEffectOn: event.target.value,
                  });
                }}
                className={FIELD_DATA}
              />
            </label>
            <label className={LABEL}>
              {t("registers.apartment.terminations.reference")}
              <input
                type="text"
                required
                maxLength={500}
                value={termination.reference}
                onChange={(event) => {
                  onChangeTermination({
                    ...termination,
                    reference: event.target.value,
                  });
                }}
                className={FIELD}
              />
              <span className={HINT}>
                {t("registers.apartment.terminations.referenceHint")}
              </span>
            </label>
            <p className={HINT}>
              {t("registers.apartment.terminations.appendOnly")}
            </p>
            <div className="flex gap-2">
              <button type="submit" className={PRIMARY_BUTTON}>
                {t("registers.apartment.terminations.submit")}
              </button>
              <button
                type="button"
                onClick={onCancelTermination}
                className={SECONDARY_BUTTON}
              >
                {t("registers.apartment.terminations.cancel")}
              </button>
            </div>
          </form>
        )}
      </section>
    </article>
  );
}

/**
 * Records the day the association decided on one transfer's membership.
 *
 * Its own component so the date it holds belongs to the transfer it is on. A
 * single draft on the screen would put the value a board typed for one transfer
 * into the input on the next one.
 *
 * Empty rather than defaulted to today, unlike the lien release beside it. A
 * release is normally recorded the day it happens; a membership decision is
 * normally minuted at a board meeting some days before anybody types it in, and
 * a prefilled today would be the wrong answer offered as the easy one - on a
 * date that starts a statutory window and cannot be corrected afterwards.
 */
function MembershipDecisionControl({
  transferId,
  onRecord,
}: {
  transferId: string;
  onRecord: (transferId: string, decidedOn: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [decidedOn, setDecidedOn] = useState("");

  return (
    <span className="flex flex-wrap items-center gap-2 print:hidden">
      <label className="flex items-center gap-2 text-small text-ink-muted">
        {t("registers.apartment.transfers.membershipDecidedLabel")}
        <input
          type="date"
          value={decidedOn}
          max={today()}
          onChange={(event) => {
            setDecidedOn(event.target.value);
          }}
          className={FIELD_DATA}
        />
      </label>
      <button
        type="button"
        disabled={decidedOn === ""}
        onClick={() => {
          onRecord(transferId, decidedOn);
        }}
        className={QUIET_BUTTON}
      >
        {t("registers.apartment.transfers.membershipDecidedSubmit")}
      </button>
    </span>
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
 * Today on the association's calendar, which every date on this screen is a
 * date on.
 *
 * {@link localDayNow} and not the device's own year, month and day. The three
 * dates here are a lien release, the day a tenant-ownership ceased and the day
 * the association decided on a membership, and the server checks the last two
 * against the Stockholm calendar - `statutoryDate` refuses a day after
 * `localDayOf(now)`. A device in another zone disagrees with that for part of
 * every day, in both directions: west of Stockholm after local midnight there
 * the input would refuse the very day a termination took effect, and east of it
 * before midnight the input would offer tomorrow and the API would refuse it.
 * Either way a board is stopped from recording the legally correct date on a
 * row nobody can correct afterwards, at the start of a statutory two-week
 * window under Lag (2026:484) 3 kap.
 *
 * The zone itself is named once in the client, in the booking module's
 * calendar, so that no screen can quietly fall back to the viewer's own.
 */
function today(): string {
  return localDayNow();
}
