import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
  type ApartmentRegisterTransfer,
  type LandTenure,
  type TerminationKind,
  type TransferReportBasis,
  type TransferReversalKind,
  fetchApartmentRegister,
  fetchOwnApartmentRegister,
  noteLien,
  recordLandTenure,
  recordPropertyDesignation,
  recordReportBasis,
  recordTermination,
  recordTransferReversal,
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

/**
 * The five cases of Lag (2026:484) 3 kap. 3 §, in the order the form offers
 * them, which is the order the statute states them in.
 *
 * No default is selected. Which case an overgang falls in is a statement about
 * facts the board knows and the platform does not, and a preselected first
 * option is the answer a hurried click gives - on a value that fixes which
 * paragraph a statutory deadline is computed under and cannot be changed
 * afterwards.
 */
const REPORT_BASES: TransferReportBasis[] = [
  "MEMBERSHIP_DECISION",
  "ALREADY_MEMBER",
  "OUTSIDE_MEMBERSHIP_REQUIREMENT",
  "TO_THE_ASSOCIATION",
  "LIENHOLDING_JURIDICAL_PERSON",
];

/** The two things tredje stycket names, in the order the form offers them. */
const REVERSAL_KINDS: TransferReversalKind[] = [
  "RESCINDED",
  "RETURNED_TO_SELLER",
];

/** The three answers Forordning (2026:898) 2 kap. 4 § distinguishes. */
const LAND_TENURES: LandTenure[] = ["OWNERSHIP", "SITE_LEASEHOLD", "OTHER"];

/**
 * What the board is recording about an overlatelse that has gone back.
 *
 * Carries the transfer it undoes rather than only the apartment, because an
 * apartment has a history of transfers and this is about one of them.
 */
interface ReversalDraft {
  transferId: string;
  kind: TransferReversalKind;
  reversedOn: string;
  reference: string;
}

/**
 * What the board is recording about the land the buildings stand on.
 *
 * The two conditional fields are kept in the draft whatever the tenure is, so a
 * board that picks the wrong one and corrects it does not lose what it typed.
 * They are only sent where the tenure reports them; see the submit handler.
 */
interface LandTenureDraft {
  landTenure: LandTenure | "";
  taxAssessmentUnitNumber: string;
  propertyType: string;
}

/**
 * Who the tenant-ownership came from, in words.
 *
 * A missing name means three different things, and the register now records
 * which. An upplatelse has no seller because the right comes into being; an
 * overgang whose seller the register never held has one the document cannot
 * name; and a row written before the kind was recorded says neither. Printing
 * "Upplatelse" for all three - which is what this screen did - states the
 * association granted a bostadsratt it may only have registered a sale of.
 */
function fromSide(transfer: ApartmentRegisterTransfer, t: TFunction): string {
  if (transfer.fromName !== null) {
    return transfer.fromName;
  }
  if (transfer.kind === "GRANT") {
    return t("registers.apartment.transfers.firstGrant");
  }
  if (transfer.kind === "TRANSFER") {
    return t("registers.apartment.transfers.sellerUnknown");
  }
  return t("registers.apartment.transfers.kindUnrecorded");
}

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
  // Whether a termination is in flight; see submitTermination below.
  const [recordingTermination, setRecordingTermination] = useState(false);
  // Its own state, not the termination one. Both acts are recorded from this
  // screen and they are different register events with different consequences,
  // so a board told a termination was refused after a membership decision was
  // refused would go looking for the wrong record - and might record the
  // termination again to fix it.
  const [basisFailed, setBasisFailed] = useState(false);
  const [reversal, setReversal] = useState<ReversalDraft | null>(null);
  const [reversalFailed, setReversalFailed] = useState(false);
  // Whether a reversal is in flight. Its own flag for the reason the
  // termination's has one: this route inserts into an append-only table, so a
  // second click writes a second statutory row nobody can take back out.
  const [recordingReversal, setRecordingReversal] = useState(false);
  const [designation, setDesignation] = useState<string | null>(null);
  const [designationFailed, setDesignationFailed] = useState(false);
  const [tenure, setTenure] = useState<LandTenureDraft | null>(null);
  const [tenureFailed, setTenureFailed] = useState(false);

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

  /*
   * One request at a time, and this one matters more than the guard on the
   * membership decision beside it. That route refuses a second value; this one
   * inserts, so a resubmitted form writes a second termination - and the table
   * is append-only with UPDATE and DELETE revoked, so nobody can take the
   * duplicate back out. A register stating that one tenant-ownership ceased
   * twice is a register that has to be explained to Lantmateriet by hand.
   *
   * A pending flag on the form is not a uniqueness rule and does not pretend to
   * be one: two tabs or a replayed request still reach the route twice. It
   * closes the ordinary way it happens - an impatient second click on a slow
   * request - and the durable answer belongs with the reporting work, which is
   * where a duplicate would first be noticed. A server-side "one per apartment"
   * rule is deliberately not it: an apartment whose bostadsratt has ceased may
   * be granted a new one, which may in turn cease, so a later termination on the
   * same apartment is legitimate.
   */
  const submitTermination = useCallback(
    async (input: TerminationDraft): Promise<void> => {
      setTerminationFailed(false);
      setRecordingTermination(true);
      try {
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
      } finally {
        setRecordingTermination(false);
      }
    },
    [load],
  );

  const submitReportBasis = useCallback(
    async (
      transferId: string,
      basis: TransferReportBasis,
      membershipDecidedOn: string | null,
    ): Promise<void> => {
      setBasisFailed(false);
      const result = await recordReportBasis({
        transferId,
        basis,
        // Sent only by the one case that has a decision. The server refuses a
        // date on any other rather than dropping it, so a value that leaked
        // through here would surface as a refusal the board could read - not as
        // a statutory date quietly discarded.
        membershipDecidedOn,
      });
      if (!result.ok) {
        setBasisFailed(true);
        return;
      }
      await load();
    },
    [load],
  );

  const submitReversal = useCallback(
    async (input: ReversalDraft): Promise<void> => {
      setReversalFailed(false);
      setRecordingReversal(true);
      try {
        const result = await recordTransferReversal({
          transferId: input.transferId,
          kind: input.kind,
          reversedOn: input.reversedOn,
          reference: input.reference.trim(),
        });
        if (!result.ok) {
          setReversalFailed(true);
          return;
        }
        setReversal(null);
        await load();
      } finally {
        setRecordingReversal(false);
      }
    },
    [load],
  );

  const submitTenure = useCallback(
    async (input: LandTenureDraft): Promise<void> => {
      setTenureFailed(false);
      const reports = input.landTenure === "OTHER";
      const result = await recordLandTenure({
        // Cleared rather than stored empty, the way the designation is: the
        // register states an answer or says none is recorded.
        landTenure: input.landTenure === "" ? null : input.landTenure,
        // Sent only where Forordning (2026:898) 2 kap. 4 § andra stycket reports
        // them. The server refuses them beside any other tenure, and the
        // database refuses to hold them there, so the form must not offer a
        // value it would have to discard.
        taxAssessmentUnitNumber: reports
          ? input.taxAssessmentUnitNumber.trim() || null
          : null,
        propertyType: reports ? input.propertyType.trim() || null : null,
      });
      if (!result.ok) {
        setTenureFailed(true);
        return;
      }
      setTenure(null);
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
        {basisFailed ? (
          <Notice tone="danger" live>
            {t("registers.apartment.transfers.basisFailed")}
          </Notice>
        ) : null}
        {reversalFailed ? (
          <Notice tone="danger" live>
            {t("registers.apartment.reversals.failed")}
          </Notice>
        ) : null}
        {tenureFailed ? (
          <Notice tone="danger" live>
            {t("registers.apartment.landTenure.failed")}
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

        {/*
          On what footing the buildings stand on their land, and the two fields
          Forordning (2026:898) 2 kap. 4 § andra stycket reports on the strength
          of one of the three answers. Beside the designation because the two are
          one register question: that paragraph decides, on this answer, whether
          the designation is reported at all.

          Not read off the broker information page, which holds a site-leasehold
          boolean. False there means the association owns the land, so that field
          has no value for buildings standing on land it does neither - the case
          the paragraph turns on - and nothing statutory may be derived from that
          page in any event.
        */}
        {isBoard && extract !== null ? (
          tenure === null ? (
            <button
              type="button"
              onClick={() => {
                setTenure({
                  landTenure: extract.housingCooperative.landTenure ?? "",
                  taxAssessmentUnitNumber:
                    extract.housingCooperative.taxAssessmentUnitNumber ?? "",
                  propertyType: extract.housingCooperative.propertyType ?? "",
                });
              }}
              className={QUIET_BUTTON}
            >
              {extract.housingCooperative.landTenure === null
                ? t("registers.apartment.landTenure.add")
                : t("registers.apartment.landTenure.edit")}
            </button>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void submitTenure(tenure);
              }}
            >
              <label className={LABEL}>
                {t("registers.apartment.landTenure.label")}
                <select
                  value={tenure.landTenure}
                  onChange={(event) => {
                    setTenure({
                      ...tenure,
                      // The select offers exactly the three answers plus the
                      // blank that clears the field, so its value is one of
                      // them; the cast carries that from the DOM's string back
                      // into the union.
                      landTenure: event.target.value as LandTenure | "",
                    });
                  }}
                  className={FIELD}
                >
                  <option value="">
                    {t("registers.apartment.landTenure.unrecorded")}
                  </option>
                  {LAND_TENURES.map((value) => (
                    <option key={value} value={value}>
                      {t(`registers.apartment.landTenure.value.${value}`)}
                    </option>
                  ))}
                </select>
                <span className={HINT}>
                  {t("registers.apartment.landTenure.hint")}
                </span>
              </label>

              {/*
                Offered only in the case that reports them, because the server
                refuses them beside any other tenure and the database will not
                hold them there. A field the board could fill in and then have
                silently dropped is a statutory value it believes it recorded.
              */}
              {tenure.landTenure === "OTHER" ? (
                <>
                  <label className={LABEL}>
                    {t("registers.apartment.landTenure.taxUnit")}
                    <input
                      type="text"
                      value={tenure.taxAssessmentUnitNumber}
                      maxLength={200}
                      onChange={(event) => {
                        setTenure({
                          ...tenure,
                          taxAssessmentUnitNumber: event.target.value,
                        });
                      }}
                      className={FIELD}
                    />
                  </label>
                  <label className={LABEL}>
                    {t("registers.apartment.landTenure.propertyType")}
                    <input
                      type="text"
                      value={tenure.propertyType}
                      maxLength={200}
                      onChange={(event) => {
                        setTenure({
                          ...tenure,
                          propertyType: event.target.value,
                        });
                      }}
                      className={FIELD}
                    />
                    <span className={HINT}>
                      {t("registers.apartment.landTenure.propertyTypeHint")}
                    </span>
                  </label>
                </>
              ) : null}

              <div className="flex flex-wrap gap-3">
                <button type="submit" className={PRIMARY_BUTTON}>
                  {t("registers.apartment.landTenure.submit")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTenure(null);
                  }}
                  className={SECONDARY_BUTTON}
                >
                  {t("registers.apartment.landTenure.cancel")}
                </button>
              </div>
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
            {extract.housingCooperative.landTenure === null ? null : (
              <p className="text-small text-ink-muted">
                {`${t("registers.apartment.landTenure.label")} ${t(`registers.apartment.landTenure.value.${extract.housingCooperative.landTenure}`)}`}
              </p>
            )}
            {extract.housingCooperative.taxAssessmentUnitNumber ===
            null ? null : (
              <p className="font-data text-data text-ink-muted">
                {`${t("registers.apartment.landTenure.taxUnit")} ${extract.housingCooperative.taxAssessmentUnitNumber}`}
              </p>
            )}
            {extract.housingCooperative.propertyType === null ? null : (
              <p className="font-data text-data text-ink-muted">
                {`${t("registers.apartment.landTenure.propertyType")} ${extract.housingCooperative.propertyType}`}
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
                  recordingTermination={recordingTermination}
                  onSubmitTermination={(input) => {
                    void submitTermination(input);
                  }}
                  onRecordReportBasis={submitReportBasis}
                  reversal={
                    reversal !== null &&
                    row.transfers.some(
                      (transfer) => transfer.id === reversal.transferId,
                    )
                      ? reversal
                      : null
                  }
                  onStartReversal={(transferId) => {
                    setReversal({
                      transferId,
                      // No opening default on the ground, for the reason the
                      // report basis has none: which of the two happened is a
                      // statement about a contract, on a row nothing can
                      // correct. RESCINDED leads because it is the first the
                      // sentence names, and the form refuses to submit until a
                      // date and a reference are there anyway.
                      kind: "RESCINDED",
                      reversedOn: "",
                      reference: "",
                    });
                  }}
                  onCancelReversal={() => {
                    setReversal(null);
                  }}
                  onChangeReversal={setReversal}
                  recordingReversal={recordingReversal}
                  onSubmitReversal={(input) => {
                    void submitReversal(input);
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
  recordingTermination,
  onSubmitTermination,
  onRecordReportBasis,
  reversal,
  onStartReversal,
  onCancelReversal,
  onChangeReversal,
  recordingReversal,
  onSubmitReversal,
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
  recordingTermination: boolean;
  onSubmitTermination: (draft: TerminationDraft) => void;
  onRecordReportBasis: (
    transferId: string,
    basis: TransferReportBasis,
    decidedOn: string | null,
  ) => Promise<void>;
  reversal: ReversalDraft | null;
  onStartReversal: (transferId: string) => void;
  onCancelReversal: () => void;
  onChangeReversal: (draft: ReversalDraft) => void;
  recordingReversal: boolean;
  onSubmitReversal: (draft: ReversalDraft) => void;
}): ReactElement {
  const { t } = useTranslation();

  /*
   * Which of this apartment's transfers already carry a reversal. A set rather
   * than a scan per row: the list is short but the lookup is inside the map over
   * it, and the shape says what the question is.
   */
  const reversedTransferIds = new Set(
    row.transferReversals.map((entry) => entry.transferId),
  );

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
                    from: fromSide(transfer, t),
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
                  Which case of Lag (2026:484) 3 kap. 3 § the overgang falls in,
                  and with it the day the reporting window opens or that the
                  report is somebody else's. Shown once stated, and offered for
                  stating while it is absent - never described as missing, since
                  three of that section's four cases have no membership decision
                  at all and a register must not call one of those a gap.
                */}
                {transfer.kind === "GRANT" ? (
                  // An upplatelse takes no membership decision: its report is
                  // due two weeks from the grant itself (Lag (2026:484) 3 kap.
                  // 2 §), and the duty was entered when it was recorded. Stated
                  // rather than offered, because the server refuses the date.
                  <span className="text-small text-ink-muted">
                    {t("registers.apartment.transfers.grantReportedFromGrant")}
                  </span>
                ) : transfer.reportBasis !== null ? (
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-small text-ink-muted">
                      {t(
                        `registers.apartment.transfers.basis.${transfer.reportBasis}`,
                      )}
                    </span>
                    {transfer.membershipDecidedOn === null ? null : (
                      <span className="font-data text-data text-ink-muted">
                        {`${t("registers.apartment.transfers.membershipDecided")} ${transfer.membershipDecidedOn}`}
                      </span>
                    )}
                  </span>
                ) : transfer.membershipDecidedOn !== null ? (
                  // A row whose decision date was recorded before the case was
                  // asked for. Its duty is in the ledger on the right paragraph
                  // and the right day, so nothing more is offered on it.
                  <span className="font-data text-data text-ink-muted">
                    {`${t("registers.apartment.transfers.membershipDecided")} ${transfer.membershipDecidedOn}`}
                  </span>
                ) : canWrite ? (
                  <ReportBasisControl
                    transferId={transfer.id}
                    onRecord={onRecordReportBasis}
                  />
                ) : null}

                {/*
                  Recording that this overlatelse went back. Offered only where
                  no reversal is recorded for it and only on an overgang: the
                  row is unique per transfer, so a second attempt is refused by
                  the database, and an upplatelse has no earlier holder for the
                  bostadsratt to go back to, which the database refuses too. A
                  control that could only fail is a control the screen should
                  not carry - the rule that a screen offers nothing the server
                  would refuse. A row whose kind was never recorded keeps the
                  control: what it was is not recorded, and refusing it here
                  would be the platform deciding.
                */}
                {canWrite &&
                transfer.kind !== "GRANT" &&
                !reversedTransferIds.has(transfer.id) ? (
                  <button
                    type="button"
                    onClick={() => {
                      onStartReversal(transfer.id);
                    }}
                    className={`${QUIET_BUTTON} print:hidden`}
                  >
                    {t("registers.apartment.reversals.add")}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {reversal === null ? null : (
          <TransferReversalForm
            draft={reversal}
            recording={recordingReversal}
            onChange={onChangeReversal}
            onCancel={onCancelReversal}
            onSubmit={onSubmitReversal}
          />
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h4 className="text-label text-ink-muted uppercase">
          {t("registers.apartment.reversals.heading")}
        </h4>
        {row.transferReversals.length === 0 ? (
          <p className="text-body text-ink-muted">
            {t("registers.apartment.reversals.none")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {row.transferReversals.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2"
              >
                <span className="font-data text-data text-ink">
                  {entry.reversedOn}
                </span>
                <span className="text-body text-ink">
                  {t(`registers.apartment.reversals.kind.${entry.kind}`)}
                </span>
                <span className="font-data text-data text-ink-muted">
                  {`${t("registers.apartment.reversals.reference")} ${entry.reference}`}
                </span>
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
              if (recordingTermination) {
                return;
              }
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
              <button
                type="submit"
                disabled={recordingTermination}
                className={PRIMARY_BUTTON}
              >
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
 * States which case of Lag (2026:484) 3 kap. 3 § one overgang falls in.
 *
 * Its own component so the values it holds belong to the transfer it is on. A
 * single draft on the screen would put the case a board chose for one transfer
 * into the control on the next one.
 *
 * The date appears only for the case that has one, and disappears when the board
 * chooses another. The server refuses a date beside any other case rather than
 * dropping it, and this is the same rule stated on the screen: a control that
 * offers a value the server would refuse is the thing this codebase has decided
 * twice not to build.
 *
 * Empty rather than defaulted to today, unlike the lien release beside it. A
 * release is normally recorded the day it happens; a membership decision is
 * normally minuted at a board meeting some days before anybody types it in, and
 * a prefilled today would be the wrong answer offered as the easy one - on a
 * date that starts a statutory window and cannot be corrected afterwards. The
 * case itself opens unchosen for the same reason.
 *
 * One request at a time. A second click while the first is in flight sends the
 * statement twice, and the route refuses a transfer that already carries one, so
 * the board would be told the recording failed by the very request that proves
 * it succeeded - on a value that cannot be recorded again.
 */
function ReportBasisControl({
  transferId,
  onRecord,
}: {
  transferId: string;
  onRecord: (
    transferId: string,
    basis: TransferReportBasis,
    decidedOn: string | null,
  ) => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const [basis, setBasis] = useState<TransferReportBasis | "">("");
  const [decidedOn, setDecidedOn] = useState("");
  const [recording, setRecording] = useState(false);

  const needsDate = basis === "MEMBERSHIP_DECISION";
  const ready = basis !== "" && (!needsDate || decidedOn !== "");

  return (
    <span className="flex flex-wrap items-center gap-2 print:hidden">
      <label className="flex items-center gap-2 text-small text-ink-muted">
        {t("registers.apartment.transfers.basisLabel")}
        <select
          value={basis}
          onChange={(event) => {
            // The select offers exactly the five cases plus the unchosen blank,
            // so its value is one of them; the cast carries that from the DOM's
            // string back into the union.
            setBasis(event.target.value as TransferReportBasis | "");
          }}
          className={FIELD}
        >
          <option value="">
            {t("registers.apartment.transfers.basisUnchosen")}
          </option>
          {REPORT_BASES.map((value) => (
            <option key={value} value={value}>
              {t(`registers.apartment.transfers.basis.${value}`)}
            </option>
          ))}
        </select>
      </label>

      {needsDate ? (
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
      ) : null}

      <button
        type="button"
        disabled={!ready || recording}
        onClick={() => {
          if (recording || basis === "") {
            return;
          }
          setRecording(true);
          void onRecord(
            transferId,
            basis,
            needsDate ? decidedOn : null,
          ).finally(() => {
            setRecording(false);
          });
        }}
        className={QUIET_BUTTON}
      >
        {t("registers.apartment.transfers.basisSubmit")}
      </button>
    </span>
  );
}

/**
 * Records that a registered overlatelse has been havd or has gone back to the
 * seller (Lag (2026:484) 3 kap. 3 § tredje stycket).
 *
 * A form rather than an inline control, on the termination's shape: it writes a
 * row to an append-only table and needs a ground, a date and a reference, and
 * the note that it cannot be edited or removed belongs where the board reads it
 * before submitting rather than after.
 */
function TransferReversalForm({
  draft,
  recording,
  onChange,
  onCancel,
  onSubmit,
}: {
  draft: ReversalDraft;
  recording: boolean;
  onChange: (draft: ReversalDraft) => void;
  onCancel: () => void;
  onSubmit: (draft: ReversalDraft) => void;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <form
      className="flex flex-col gap-3 print:hidden"
      onSubmit={(event) => {
        event.preventDefault();
        if (recording) {
          return;
        }
        onSubmit(draft);
      }}
    >
      <label className={LABEL}>
        {t("registers.apartment.reversals.kindLabel")}
        <select
          value={draft.kind}
          onChange={(event) => {
            onChange({
              ...draft,
              // The select offers exactly the two grounds, so its value is one
              // of them; the cast carries that back into the union.
              kind: event.target.value as TransferReversalKind,
            });
          }}
          className={FIELD}
        >
          {REVERSAL_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`registers.apartment.reversals.kind.${kind}`)}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL}>
        {t("registers.apartment.reversals.reversedOn")}
        <input
          type="date"
          required
          value={draft.reversedOn}
          max={today()}
          onChange={(event) => {
            onChange({ ...draft, reversedOn: event.target.value });
          }}
          className={FIELD_DATA}
        />
      </label>
      <label className={LABEL}>
        {t("registers.apartment.reversals.reference")}
        <input
          type="text"
          required
          maxLength={500}
          value={draft.reference}
          onChange={(event) => {
            onChange({ ...draft, reference: event.target.value });
          }}
          className={FIELD}
        />
        <span className={HINT}>
          {t("registers.apartment.reversals.referenceHint")}
        </span>
      </label>
      <p className={HINT}>{t("registers.apartment.reversals.appendOnly")}</p>
      <div className="flex gap-2">
        <button type="submit" disabled={recording} className={PRIMARY_BUTTON}>
          {t("registers.apartment.reversals.submit")}
        </button>
        <button type="button" onClick={onCancel} className={SECONDARY_BUTTON}>
          {t("registers.apartment.reversals.cancel")}
        </button>
      </div>
    </form>
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
