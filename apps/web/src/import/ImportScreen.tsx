import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { TranslationKey } from "../i18n/translation-key";
import { useViewerAccess } from "../shell/use-viewer-capabilities";
import {
  CAUTION_BUTTON,
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { formatMoment } from "../ui/moment";
import { Notice } from "../ui/Notice";
import { NotRecorded } from "../ui/NotRecorded";
import {
  abandonImport,
  applyImport,
  cancelImportPreview,
  fetchActiveImport,
  fetchImportPreview,
  fetchImportRun,
  type ImportDecision,
  type ImportField,
  IMPORT_FIELDS,
  IMPORT_TEMPLATE_URL,
  type ImportNotInSource,
  type ImportPreview,
  type ImportPreviewRow,
  type ImportPreviewRun,
  type ImportProposalView,
  type ImportRunView,
  type ImportSessionView,
  type ImportUnchangedView,
  isImportRunning,
  openImportProposal,
  previewImport,
  readFileAsBase64,
  type StartedImportRun,
  uploadImport,
} from "./import-api";
import {
  FAILURE_VALUES,
  failureMessage,
  FILL_LABEL,
  mappingProblemMessages,
  FIELD_LABEL,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  previewRowKind,
  type PreviewRowKind,
  problemMessage,
  RUN_STATUS_LABEL,
  RUN_TITLE,
} from "./import-messages";
import { ImportProposals, ProposalSummary } from "./ImportProposals";

/**
 * Importing an existing member list.
 *
 * Four steps, and the third is the reason for the other three. An import writes
 * into the statutory member register, which the database will not let anyone
 * update or delete, so nothing is written until the board has seen every row
 * that would be created and every person that would be matched.
 *
 * Two things the screen states rather than assumes. An update fills in what the
 * register does not have and never overwrites what it does. And a row matching
 * more than one person is not resolved by the import: it waits, because the two
 * candidates are usually a parent and a child of the same name in the same
 * apartment. So does a row whose identity number or name contradicts the one
 * person it matched: an email address or a name reached them, and neither says
 * the row is about them.
 *
 * A list is rarely imported once: the next file from the same place comes back
 * with the same column titles, and the API keeps two things for it. The mapping
 * the board last started an import with is offered again in place of the guess,
 * and a file holding exactly the rows imported last is answered as unchanged,
 * with nothing to review unless the board asks to. The preview of a file
 * imported again tells the rows the register already agrees with apart from
 * those that change it, and lists who the register holds as living here that
 * the file leaves out. That list is for reading: nothing here ends a residency.
 *
 * A plugin may hand the board a member list too - one mailed to the
 * association, say (ADR 0043). It waits at the top of the upload step as a
 * proposal, and opening it is uploading it: the same mapping, preview and
 * apply, by a board member. A proposal the plugin replaces, takes back or lets
 * expire while it is being reviewed is refused at the next step, and the screen
 * goes back to the list, where the newer one waits.
 *
 * A decision can change what the rows after it match: the person chosen for a
 * row gets its email address, and a later row can contradict that. So the API
 * starts an import only with the decisions its preview was planned with. The
 * screen previews again with the decisions made so far, and applies them once
 * that preview is ready: at once when it shows what the board already saw,
 * and otherwise once the board has seen the rows that now need a decision.
 *
 * Neither the preview nor the import is this screen's work. Matching a long
 * file against a register that holds identity numbers takes minutes, and
 * writing the register takes longer, so both are background jobs and the screen
 * only watches them: it asks the API how far each has got and shows that. The
 * import's progress lives on the import itself, so closing the tab costs
 * nothing - the screen finds it again by asking for the import that is running
 * rather than by remembering anything. A preview is only worth having while
 * somebody is looking at it, so a reload simply asks for a new one.
 */

type Step = "upload" | "mapping" | "preview" | "apply";

const STEPS: readonly Step[] = ["upload", "mapping", "preview", "apply"];

/**
 * How often the screen asks how far the import has got.
 *
 * Asking, rather than being told: the progress is a column on the import, one
 * indexed row to read, and a running import is minutes at the very most. A
 * stream would add a connection per watching browser and a second way for the
 * same fact to travel, and it would still not spare the screen the read it does
 * on load.
 */
const RUN_POLL_MS = 1500;

/**
 * How often the screen asks how far the preview has got. The same reasoning as
 * {@link RUN_POLL_MS}, and the asking is also what tells the API that somebody
 * is still waiting for the preview: one nobody asks about is stopped.
 */
const PREVIEW_POLL_MS = 1500;

/**
 * How long a poll may go without an answer starting to arrive before the screen
 * gives it up and asks again. Downloading a preview that is ready is not
 * limited: a slow link is not a request that never reached the server. A poll
 * is only skipped while the last one is unanswered, so one that never settles -
 * a stalled connection, a proxy that holds the request - would otherwise end the
 * asking, and with it the progress, for good.
 */
const PREVIEW_POLL_TIMEOUT_MS = 4 * PREVIEW_POLL_MS;

const CELL = "px-3 py-2 text-left align-top";
const HEAD_CELL = `${CELL} text-label uppercase text-ink-muted`;
const DATA_CELL = `${CELL} font-data text-data text-ink`;

export function ImportScreen(): ReactElement {
  const { t } = useTranslation();
  // Every write here needs addressBook:write, which a support session (ADR
  // 0028) does not hold; it is offered neither the upload nor the abandon.
  const { capabilities, readOnly } = useViewerAccess();
  const canAbandon = capabilities.includes("association:manage") && !readOnly;

  const [step, setStep] = useState<Step>("upload");
  const [session, setSession] = useState<ImportSessionView | null>(null);
  /** Bumped to read the proposals again, when an open found one had ended. */
  const [proposalsVersion, setProposalsVersion] = useState(0);
  /** The proposal the session was opened from, when it was one. */
  const [proposal, setProposal] = useState<{
    view: ImportProposalView;
    columnsChanged: boolean;
  } | null>(null);
  /** A file answered as the one imported last, held to review it anyway. */
  const [unchanged, setUnchanged] = useState<{
    file: File;
    view: ImportUnchangedView;
  } | null>(null);
  const [mapping, setMapping] = useState<(ImportField | null)[]>([]);
  const [defaultRole, setDefaultRole] = useState<"MEMBER" | "RESIDENT">(
    "MEMBER",
  );
  const [defaultMovedInOn, setDefaultMovedInOn] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  /** The preview being planned, while the screen waits for it. */
  const [planning, setPlanning] = useState<ImportPreviewRun | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ImportDecision>>(
    {},
  );
  /** Whether the preview shown was taken again because of the decisions. */
  const [replanned, setReplanned] = useState(false);
  const [run, setRun] = useState<ImportRunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<TranslationKey | null>(null);
  /** What the API found wrong with the mapping, when it refused it. */
  const [mappingProblems, setMappingProblems] = useState<TranslationKey[]>([]);
  /**
   * Which preview request the screen is still waiting for.
   *
   * Stepping back, or leaving the page, ends the wait for a request that has
   * not been answered yet. The answer comes anyway, and what it starts has to
   * be cancelled rather than followed: see `runPreview`.
   */
  const previewRequest = useRef(0);
  /**
   * What the preview asked for last keeps of the board's decisions, whether it
   * was asked for again because of them, and the preview the board applied
   * them on, when the apply asked for it. Read when it is ready.
   */
  const pendingPreview = useRef<{
    kept: Record<string, ImportDecision>;
    replanned: boolean;
    appliedOn: ImportPreview | null;
  }>({ kept: {}, replanned: false, appliedOn: null });
  /**
   * The token of a preview to apply as soon as it is shown: one taken because
   * the apply asked for one with the decisions, which shows the board nothing
   * it had not already seen.
   */
  const applyOnShow = useRef<string | null>(null);
  const [activeImportKnown, setActiveImportKnown] = useState(false);

  const mapped = new Set(mapping.filter((field) => field !== null));
  const needsDefaultRole = !mapped.has("role");
  const needsDefaultMovedIn = !mapped.has("movedInOn");

  /**
   * Picks up an import that is already under way.
   *
   * A board member who reloaded, or who closed the tab and came back, holds
   * nothing that identifies the import they started. The API answers that
   * question instead, so what they see is the import rather than an empty form
   * suggesting nothing ever happened.
   *
   * The upload form is not shown until the answer is in; a status line stands
   * in for it meanwhile. The answer decides whether there is a form to fill in
   * at all: when it names an import, running or finished, the screen shows
   * that import instead, and a file sent before the answer arrived could
   * become a second write into the register. Waiting for
   * the answer also means it never lands on top of a mapping step the board
   * member has already reached. An answer that does not come through shows
   * the form as well, since a failed request says nothing about an import.
   */
  useEffect(() => {
    let abandoned = false;

    void (async () => {
      const response = await fetchActiveImport();
      if (abandoned) {
        return;
      }
      if (response.ok && response.value !== null) {
        setRun(response.value);
        setStep("apply");
      }
      setActiveImportKnown(true);
    })();

    return () => {
      abandoned = true;
    };
  }, []);

  const watchedSessionId =
    run !== null && isImportRunning(run.status) ? run.sessionId : null;

  useEffect(() => {
    if (watchedSessionId === null) {
      return;
    }
    let abandoned = false;

    const timer = setInterval(() => {
      void (async () => {
        const response = await fetchImportRun(watchedSessionId);
        if (!abandoned && response.ok) {
          setRun(response.value);
        }
      })();
    }, RUN_POLL_MS);

    return () => {
      abandoned = true;
      clearInterval(timer);
    };
  }, [watchedSessionId]);

  /**
   * Ends the wait for a preview that is not coming.
   *
   * Asking for a preview withdrew the token of the one before it, so a preview
   * still on the screen - the one the board was deciding on when the apply
   * asked for it again - can no longer be applied. It goes, with the decisions
   * made against it, and the board previews again from the mapping.
   */
  const abandonPreview = useCallback(
    (reason: string, detail?: unknown): void => {
      if (reason.startsWith("proposal-")) {
        // The proposal ended while it was being reviewed: the plugin sent a
        // newer one, took it back, or it expired. Nothing was written, and
        // the list shows what waits now.
        setPlanning(null);
        setPreview(null);
        setDecisions({});
        setReplanned(false);
        setSession(null);
        setProposal(null);
        setMappingProblems([]);
        setFailure(failureMessage(reason));
        setStep("upload");
        return;
      }
      setMappingProblems(
        reason === "mapping-invalid" ? mappingProblemMessages(detail) : [],
      );
      setPlanning(null);
      setPreview(null);
      setDecisions({});
      setReplanned(false);
      setFailure(failureMessage(reason));
      setStep("mapping");
    },
    [],
  );

  /** Takes in what the API says about the preview being planned. */
  const receivePreview = useCallback(
    (next: ImportPreviewRun): void => {
      if (next.status === "READY" && next.preview !== null) {
        const { kept, replanned: again, appliedOn } = pendingPreview.current;
        const keep = keptDecisions(next.preview, kept);
        const unchanged =
          appliedOn !== null &&
          Object.keys(keep).length === Object.keys(kept).length &&
          sameRows(appliedOn, next.preview);
        setPlanning(null);
        setPreview(next.preview);
        setDecisions(keep);
        setReplanned(again && !unchanged);
        applyOnShow.current = unchanged ? next.preview.previewToken : null;
        setStep("preview");
        return;
      }
      if (next.status === "FAILED") {
        abandonPreview(next.failureReason ?? "");
        return;
      }
      setPlanning(next);
    },
    [abandonPreview],
  );

  const plannedSessionId = planning?.sessionId ?? null;
  const plannedPreviewId = planning?.previewId ?? null;

  // A plain interval rather than usePoll, which pauses while the tab is hidden:
  // here the asking is what tells the API somebody is still waiting, and a
  // board member who looks at another tab during a long preview still wants it.
  //
  // Asked once at once, then every interval: a short file is often planned
  // before the first interval is up.
  //
  // And the screen says when it stops waiting. Whatever ends the wait before
  // the preview does - another file, back to the start, leaving the page - ends
  // this effect, and a preview nobody is waiting for any more would otherwise
  // hold the one worker that plans every preview on the instance until the API
  // noticed nobody was asking.
  useEffect(() => {
    if (plannedSessionId === null || plannedPreviewId === null) {
      return;
    }
    let abandoned = false;
    /** Whether the preview has ended, so there is nothing left to cancel. */
    let settled = false;
    /** Whether a poll is still waiting for its answer. */
    let asking = false;
    /** Ends the poll in flight when the effect does. */
    const leaving = new AbortController();

    // A tick is skipped while the last poll is unanswered, or once the preview
    // has ended: the interval is only cleared when the screen has taken in the
    // answer, and a slow request would otherwise overlap the next one. A poll
    // that stays unanswered is given up after a timeout, which reads as a
    // request that never reached the server, so the next tick asks again.
    const poll = async (): Promise<void> => {
      if (asking || settled) {
        return;
      }
      asking = true;
      try {
        const response = await fetchImportPreview(
          plannedSessionId,
          plannedPreviewId,
          leaving.signal,
          PREVIEW_POLL_TIMEOUT_MS,
        );
        if (abandoned) {
          return;
        }
        if (response.ok) {
          settled = response.value.status !== "PLANNING";
          receivePreview(response.value);
          return;
        }
        // A refusal ends the wait - the preview was replaced, the upload
        // expired, or the import was started elsewhere. A request that never
        // reached the server, or a server error, is asked again.
        if (response.failure.status >= 400 && response.failure.status < 500) {
          settled = true;
          abandonPreview(response.failure.reason);
        }
      } finally {
        asking = false;
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, PREVIEW_POLL_MS);

    return () => {
      abandoned = true;
      leaving.abort();
      clearInterval(timer);
      if (!settled) {
        void cancelImportPreview(plannedSessionId, plannedPreviewId);
      }
    };
  }, [plannedSessionId, plannedPreviewId, receivePreview, abandonPreview]);

  useEffect(() => {
    const requests = previewRequest;
    return () => {
      requests.current += 1;
    };
  }, []);

  /** Takes a session to the mapping step, with the mapping it is offered. */
  const startMapping = useCallback((next: ImportSessionView): void => {
    const saved = next.savedMapping;
    setSession(next);
    setMapping(saved?.mapping ?? next.suggestedMapping);
    // And the defaults it was started with, which a file without a role or a
    // move-in column needs again. A file with none starts from the screen's
    // own, never from the file chosen before it: another source's move-in date
    // would date this file's residencies.
    setDefaultRole(saved?.defaultRole ?? "MEMBER");
    setDefaultMovedInOn(saved?.defaultMovedInOn ?? "");
    setPreview(null);
    setPlanning(null);
    setDecisions({});
    setStep("mapping");
  }, []);

  const upload = useCallback(
    async (file: File, reviewUnchanged = false): Promise<void> => {
      setBusy(true);
      setFailure(null);
      try {
        const content = await readFileAsBase64(file);
        const response = await uploadImport({
          fileName: file.name,
          content,
          ...(reviewUnchanged ? { reviewUnchanged } : {}),
        });
        if (!response.ok) {
          // A file of about 750 KiB or more is refused by the server's request
          // body limit before the import runs, with a 413 and no reason of ours.
          setFailure(
            failureMessage(
              response.failure.status === 413
                ? "file-too-large"
                : response.failure.reason,
            ),
          );
          return;
        }
        if (response.value.unchanged) {
          setUnchanged({ file, view: response.value });
          return;
        }
        setUnchanged(null);
        setProposal(null);
        startMapping(response.value);
      } catch {
        setFailure("import.errors.fileUnreadable");
      } finally {
        setBusy(false);
      }
    },
    [startMapping],
  );

  /**
   * Opens a plugin's proposal at the mapping step, as an upload is: the board
   * maps, previews and applies it, or goes back and rejects it.
   */
  const openProposal = useCallback(
    async (proposalId: string): Promise<void> => {
      setBusy(true);
      setFailure(null);
      const response = await openImportProposal(proposalId);
      setBusy(false);
      if (!response.ok) {
        setFailure(failureMessage(response.failure.reason));
        // Superseded, rejected, taken back or expired since the list was
        // read: the list as it is now shows what waits instead.
        setProposalsVersion((version) => version + 1);
        return;
      }
      setUnchanged(null);
      setProposal({
        view: response.value.proposal,
        columnsChanged: response.value.columnsChanged,
      });
      startMapping(response.value);
    },
    [startMapping],
  );

  /**
   * Asks for the preview, planned with the decisions to keep.
   *
   * A decision is kept only for a row that still needs one: a row the kept
   * decisions settle is no longer asked about, and an answer left behind for it
   * would be sent with the apply for a question the board no longer sees. A
   * person chosen for a row is kept only while the row still offers them. The
   * preview is planned by a job, so what to keep travels with the request until
   * its answer arrives: see `receivePreview`.
   */
  const runPreview = useCallback(
    async (
      kept: Record<string, ImportDecision> = {},
      again = false,
      appliedOn: ImportPreview | null = null,
    ): Promise<void> => {
      if (session === null) {
        return;
      }
      setBusy(true);
      setFailure(null);
      setReplanned(false);
      applyOnShow.current = null;
      previewRequest.current += 1;
      const request = previewRequest.current;
      pendingPreview.current = { kept, replanned: again, appliedOn };
      const response = await previewImport(session.sessionId, {
        mapping,
        defaultRole: needsDefaultRole ? defaultRole : null,
        defaultMovedInOn: needsDefaultMovedIn ? defaultMovedInOn : null,
        decisions: kept,
      });
      if (request !== previewRequest.current) {
        // The board stepped back, or left, while this was asked. The preview it
        // started is planned for nobody, and the poll that would have cancelled
        // it when the wait ended never began.
        if (response.ok && response.value.status === "PLANNING") {
          void cancelImportPreview(
            response.value.sessionId,
            response.value.previewId,
          );
        }
        return;
      }
      setBusy(false);
      if (!response.ok) {
        // A request that was refused may still have withdrawn the token of
        // the preview on the screen, if its answer was what got lost.
        abandonPreview(response.failure.reason, response.failure.detail);
        return;
      }
      receivePreview(response.value);
    },
    [
      session,
      mapping,
      needsDefaultRole,
      defaultRole,
      needsDefaultMovedIn,
      defaultMovedInOn,
      receivePreview,
      abandonPreview,
    ],
  );

  /**
   * Starts the import with the decisions on the screen.
   *
   * @param again Whether this is the apply made by itself once the preview
   *   taken for the decisions showed nothing new. Asked for again by that one,
   *   the preview is shown rather than applied a second time.
   */
  const apply = useCallback(
    async (again = false): Promise<void> => {
      if (session === null || preview === null) {
        return;
      }
      setBusy(true);
      setFailure(null);
      const response = await applyImport(session.sessionId, {
        previewToken: preview.previewToken,
        decisions,
      });
      setBusy(false);
      if (!response.ok) {
        const reason = response.failure.reason;
        if (reason === "decisions-not-previewed") {
          // The preview was planned without these decisions, and what they
          // write is the preview's to work out. Applied once it is ready when it
          // shows what this one did; otherwise the board looks at it first.
          await runPreview(decisions, true, again ? null : preview);
          return;
        }
        if (
          reason === "ambiguous-rows-undecided" ||
          reason === "preview-outdated" ||
          reason === "decision-not-a-candidate"
        ) {
          // The decisions made further rows need one, settled a row that needed
          // one, or chose somebody a row no longer matches - or another import
          // has written to the register since. Nothing was written; what the
          // board needs is the preview those decisions produce now.
          await runPreview(decisions, true);
          return;
        }
        if (reason.startsWith("proposal-")) {
          abandonPreview(reason);
          return;
        }
        setFailure(failureMessage(reason));
        if (reason === "preview-replaced") {
          // Somebody previewed this upload again, perhaps with another mapping.
          // The decisions on this screen were made against rows that preview
          // may not have, so they go, and the board checks the columns and
          // previews again. Not at once from here: that would replace the other
          // board member's preview without either of them choosing that.
          setPreview(null);
          setDecisions({});
          setStep("mapping");
          return;
        }
        if (reason === "session-already-applied") {
          // Somebody was quicker - the other tab, or the other board member. What
          // this screen should show now is that import rather than a preview step
          // that is over.
          const started = await fetchActiveImport();
          if (started.ok && started.value !== null) {
            setRun(started.value);
            setStep("apply");
          }
        }
        // "another-import-running" stays on the preview: it is a different
        // file that is running, and this one is still waiting to be applied
        // once that has finished.
        return;
      }
      setRun(response.value);
      setStep("apply");
    },
    [session, preview, decisions, runPreview, abandonPreview],
  );

  useEffect(() => {
    if (preview !== null && applyOnShow.current === preview.previewToken) {
      applyOnShow.current = null;
      void apply(true);
    }
  }, [preview, apply]);

  const restart = useCallback((): void => {
    setRun(null);
    setSession(null);
    setProposal(null);
    setUnchanged(null);
    setPreview(null);
    setPlanning(null);
    setDecisions({});
    setReplanned(false);
    setMapping([]);
    setFailure(null);
    setStep("upload");
  }, []);

  const undecided =
    preview?.rows.some(
      (row) =>
        row.outcome === "ambiguous" &&
        decisions[String(row.rowNumber)] === undefined,
    ) ?? false;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <h1 className="text-display">{t("import.heading")}</h1>
        <p className="max-w-2xl text-body text-ink-muted">
          {t("import.description")}
        </p>
      </header>

      <ol className="flex flex-wrap gap-x-6 gap-y-2">
        {STEPS.map((candidate, index) => (
          <li
            key={candidate}
            aria-current={step === candidate ? "step" : undefined}
            className={`flex items-baseline gap-2 text-label uppercase ${
              step === candidate ? "text-ink" : "text-ink-muted"
            }`}
          >
            <span className="font-data text-data">{index + 1}</span>
            {t(`import.step.${candidate}`)}
          </li>
        ))}
      </ol>

      {failure === null ? null : (
        <Notice tone="danger" live>
          {t(failure, FAILURE_VALUES)}
          {failure === "import.errors.mappingInvalid" &&
          mappingProblems.length > 0 ? (
            <>
              {mappingProblems.map((problem) => (
                <span key={problem} className="mt-1 block">
                  {t(problem)}
                </span>
              ))}
            </>
          ) : null}
        </Notice>
      )}

      {step === "upload" && !activeImportKnown ? (
        <p role="status" className="text-body text-ink-muted">
          {t("import.loading")}
        </p>
      ) : null}

      {step === "upload" && activeImportKnown && unchanged === null ? (
        <ImportProposals
          readOnly={readOnly}
          busy={busy}
          version={proposalsVersion}
          onOpen={(proposalId) => {
            void openProposal(proposalId);
          }}
        />
      ) : null}

      {step === "upload" && activeImportKnown ? (
        unchanged === null ? (
          <UploadStep busy={busy} readOnly={readOnly} onUpload={upload} />
        ) : (
          <UnchangedFile
            view={unchanged.view}
            busy={busy}
            onReview={() => {
              void upload(unchanged.file, true);
            }}
            onAnother={() => {
              setUnchanged(null);
            }}
          />
        )
      ) : null}

      {step !== "upload" && step !== "apply" && proposal !== null ? (
        <section className="flex flex-col gap-3 rounded-panel border border-line bg-raised p-5 shadow-raised">
          <ProposalSummary proposal={proposal.view} />
          {step === "mapping" && proposal.columnsChanged ? (
            <Notice tone="warn">{t("import.proposals.columnsChanged")}</Notice>
          ) : null}
        </section>
      ) : null}

      {step === "mapping" && session !== null ? (
        <MappingStep
          session={session}
          mapping={mapping}
          onChangeMapping={setMapping}
          needsDefaultRole={needsDefaultRole}
          defaultRole={defaultRole}
          onChangeDefaultRole={setDefaultRole}
          needsDefaultMovedIn={needsDefaultMovedIn}
          defaultMovedInOn={defaultMovedInOn}
          onChangeDefaultMovedIn={setDefaultMovedInOn}
          busy={busy}
          planning={planning}
          onBack={() => {
            // Ending the wait cancels the preview: see the effect above. One
            // not yet answered is cancelled when it is: see `runPreview`.
            previewRequest.current += 1;
            setBusy(false);
            setPlanning(null);
            setStep("upload");
          }}
          onSubmit={() => {
            void runPreview();
          }}
        />
      ) : null}

      {step === "preview" && preview !== null ? (
        <PreviewStep
          preview={preview}
          decisions={decisions}
          onDecide={(rowNumber, decision) => {
            setDecisions((current) => ({
              ...current,
              [String(rowNumber)]: decision,
            }));
          }}
          undecided={undecided}
          replanned={replanned}
          planning={planning}
          busy={busy}
          onBack={() => {
            setStep("mapping");
          }}
          onApply={() => {
            void apply();
          }}
        />
      ) : null}

      {step === "apply" && run !== null && run.status !== "MAPPING" ? (
        <ApplyStep
          run={{ ...run, status: run.status }}
          canAbandon={canAbandon}
          onAbandoned={setRun}
          onRestart={restart}
        />
      ) : null}
    </div>
  );
}

/** Whether two previews show the board the same rows. */
function sameRows(one: ImportPreview, other: ImportPreview): boolean {
  return JSON.stringify(one.rows) === JSON.stringify(other.rows);
}

/**
 * The decisions a preview keeps: those for rows it still asks about, and a
 * person chosen for a row only while the row still offers them.
 */
function keptDecisions(
  preview: ImportPreview,
  kept: Record<string, ImportDecision>,
): Record<string, ImportDecision> {
  return Object.fromEntries(
    preview.rows.flatMap((row) => {
      const decision = kept[String(row.rowNumber)];
      const stillOffered =
        decision?.action !== "use-person" ||
        row.candidates.some(
          (candidate) => candidate.personId === decision.personId,
        );
      return row.outcome === "ambiguous" &&
        decision !== undefined &&
        stillOffered
        ? [[String(row.rowNumber), decision]]
        : [];
    }),
  );
}

function UploadStep({
  busy,
  readOnly,
  onUpload,
}: {
  busy: boolean;
  /** Whether nothing may be sent: the file is not even offered for choosing. */
  readOnly: boolean;
  onUpload: (file: File) => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);

  return (
    <section className="flex flex-col gap-4 rounded-panel border border-line bg-raised p-5 shadow-raised">
      <h2 className="text-title">{t("import.upload.title")}</h2>
      <p className="text-body text-ink-muted">
        {t("import.upload.description")}
      </p>

      <div className="flex flex-col gap-1">
        <label className={LABEL} htmlFor="import-file">
          {t("import.upload.file")}
          <input
            id="import-file"
            type="file"
            accept=".csv,.xlsx,text/csv"
            disabled={readOnly}
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
            }}
            className={FIELD}
          />
        </label>
        <p className={HINT}>{t("import.upload.accept", FAILURE_VALUES)}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || file === null || readOnly}
          onClick={() => {
            if (file !== null) {
              void onUpload(file);
            }
          }}
          className={PRIMARY_BUTTON}
        >
          {busy ? t("import.upload.working") : t("import.upload.submit")}
        </button>

        <a href={IMPORT_TEMPLATE_URL} download className={SECONDARY_BUTTON}>
          {t("import.upload.template")}
        </a>
      </div>
      <p className={HINT}>{t("import.upload.templateHint")}</p>
    </section>
  );
}

/**
 * The answer to a file holding exactly the rows imported last from a file with
 * the same column titles. There is nothing in it the register was not given
 * then, so there is no preview to take - unless the register has been edited
 * since, which the board knows and the import does not.
 */
function UnchangedFile({
  view,
  busy,
  onReview,
  onAnother,
}: {
  view: ImportUnchangedView;
  busy: boolean;
  onReview: () => void;
  onAnother: () => void;
}): ReactElement {
  const { t, i18n } = useTranslation();

  return (
    <section className="flex flex-col gap-4 rounded-panel border border-line bg-raised p-5 shadow-raised">
      <h2 className="text-title">{t("import.unchanged.title")}</h2>
      <Notice tone="ok" live>
        {t("import.unchanged.description", {
          fileName: view.fileName,
          appliedAt: formatMoment(view.appliedAt, i18n.language),
        })}
      </Notice>
      <p className="text-body text-ink-muted">{t("import.unchanged.hint")}</p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={onAnother}
          className={PRIMARY_BUTTON}
        >
          {t("import.unchanged.another")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onReview}
          className={SECONDARY_BUTTON}
        >
          {busy ? t("import.upload.working") : t("import.unchanged.review")}
        </button>
      </div>
    </section>
  );
}

function MappingStep({
  session,
  mapping,
  onChangeMapping,
  needsDefaultRole,
  defaultRole,
  onChangeDefaultRole,
  needsDefaultMovedIn,
  defaultMovedInOn,
  onChangeDefaultMovedIn,
  busy,
  planning,
  onBack,
  onSubmit,
}: {
  session: ImportSessionView;
  mapping: (ImportField | null)[];
  onChangeMapping: (mapping: (ImportField | null)[]) => void;
  needsDefaultRole: boolean;
  defaultRole: "MEMBER" | "RESIDENT";
  onChangeDefaultRole: (role: "MEMBER" | "RESIDENT") => void;
  needsDefaultMovedIn: boolean;
  defaultMovedInOn: string;
  onChangeDefaultMovedIn: (value: string) => void;
  busy: boolean;
  planning: ImportPreviewRun | null;
  onBack: () => void;
  onSubmit: () => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const working = busy || planning !== null;
  // The preview being planned is of the mapping as it was asked for. Changing
  // it meanwhile would show a plan for columns the screen no longer holds.
  const locked = planning !== null;

  return (
    <section className="flex flex-col gap-4 rounded-panel border border-line bg-raised p-5 shadow-raised">
      <h2 id="import-mapping-title" className="text-title">
        {t("import.mapping.title")}
      </h2>
      <p className="text-body text-ink-muted">
        {t(
          session.savedMapping === null
            ? "import.mapping.description"
            : "import.mapping.descriptionSaved",
        )}
      </p>
      <p className="font-data text-data text-ink-muted">
        {t("import.mapping.fileSummary", {
          fileName: session.fileName,
          rows: session.rowCount,
          columns: session.columns.length,
        })}
      </p>
      {session.savedMapping === null ? null : (
        <Notice tone="info">
          {t("import.mapping.saved", {
            savedAt: formatMoment(
              session.savedMapping.mappingSavedAt,
              i18n.language,
            ),
          })}
        </Notice>
      )}

      <div className="overflow-x-auto">
        <table
          aria-labelledby="import-mapping-title"
          className="w-full border-collapse"
        >
          <thead>
            <tr>
              <th scope="col" className={HEAD_CELL}>
                {t("import.mapping.column")}
              </th>
              <th scope="col" className={HEAD_CELL}>
                {t("import.mapping.sample")}
              </th>
              <th scope="col" className={HEAD_CELL}>
                {t("import.mapping.field")}
              </th>
            </tr>
          </thead>
          <tbody>
            {session.columns.map((column, index) => (
              <tr key={column + String(index)} className="border-t border-line">
                <td className={`${CELL} text-body text-ink`}>{column}</td>
                <td className={DATA_CELL}>
                  {session.sample
                    .map((row) => row[index] ?? "")
                    .filter((value) => value !== "")
                    .slice(0, 2)
                    .join(", ")}
                </td>
                <td className={CELL}>
                  <select
                    /*
                     * Named after the column it maps, not after the table
                     * heading. Every select would otherwise carry the same
                     * accessible name, leaving a screen reader user moving
                     * between them with no way to tell which column they are
                     * on - and a column sent to personalIdentityNumber or role
                     * by mistake writes a register entry that cannot be
                     * corrected by editing.
                     */
                    aria-label={t("import.mapping.fieldFor", { column })}
                    value={mapping[index] ?? ""}
                    disabled={locked}
                    onChange={(event) => {
                      const next = [...mapping];
                      next[index] =
                        event.target.value === ""
                          ? null
                          : (event.target.value as ImportField);
                      onChangeMapping(next);
                    }}
                    className={FIELD}
                  >
                    <option value="">{t("import.mapping.ignore")}</option>
                    {IMPORT_FIELDS.map((field) => (
                      <option key={field} value={field}>
                        {t(FIELD_LABEL[field])}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {needsDefaultRole || needsDefaultMovedIn ? (
        <fieldset
          disabled={locked}
          className="flex flex-col gap-4 border-t border-line pt-4"
        >
          <legend className="text-label text-ink-muted uppercase">
            {t("import.mapping.defaults")}
          </legend>

          {needsDefaultRole ? (
            <div className="flex flex-col gap-1">
              <label className={LABEL} htmlFor="import-default-role">
                {t("import.mapping.defaultRole")}
                <select
                  id="import-default-role"
                  value={defaultRole}
                  onChange={(event) => {
                    onChangeDefaultRole(
                      event.target.value === "MEMBER" ? "MEMBER" : "RESIDENT",
                    );
                  }}
                  className={FIELD}
                >
                  <option value="MEMBER">{t("moves.in.roleMember")}</option>
                  <option value="RESIDENT">{t("moves.in.roleResident")}</option>
                </select>
              </label>
              <p className={HINT}>{t("import.mapping.defaultRoleHint")}</p>
            </div>
          ) : null}

          {needsDefaultMovedIn ? (
            <div className="flex flex-col gap-1">
              <label className={LABEL} htmlFor="import-default-moved-in">
                {t("import.mapping.defaultMovedInOn")}
                <input
                  id="import-default-moved-in"
                  type="date"
                  required
                  value={defaultMovedInOn}
                  onChange={(event) => {
                    onChangeDefaultMovedIn(event.target.value);
                  }}
                  className={FIELD_DATA}
                />
              </label>
              <p className={HINT}>{t("import.mapping.defaultMovedInOnHint")}</p>
            </div>
          ) : null}
        </fieldset>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={working || (needsDefaultMovedIn && defaultMovedInOn === "")}
          onClick={onSubmit}
          className={PRIMARY_BUTTON}
        >
          {working ? t("import.mapping.working") : t("import.mapping.submit")}
        </button>
        <button type="button" onClick={onBack} className={SECONDARY_BUTTON}>
          {t("import.mapping.back")}
        </button>
      </div>

      {planning === null ? null : <PlanningProgress planning={planning} />}
    </section>
  );
}

/**
 * How far the preview has got, while the board waits for it.
 *
 * The same bar as the import's own, for the same reason: a long file with
 * identity numbers is minutes of work, and a button that only says it is
 * working looks the same whether it is nearly done or stuck.
 */
function PlanningProgress({
  planning,
}: {
  planning: ImportPreviewRun;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <ProgressBar
        label={t("import.mapping.planningProgressLabel")}
        done={planning.rowsDone}
        total={planning.rowsTotal}
      />
      <p className="font-data text-data text-ink-muted">
        {t("import.run.progress", {
          done: planning.rowsDone,
          total: planning.rowsTotal,
        })}
      </p>
      <p className={HINT}>{t("import.mapping.planningHint")}</p>
    </div>
  );
}

/** Rows worked through against rows in the file, as a bar. */
function ProgressBar({
  label,
  done,
  total,
}: {
  label: string;
  done: number;
  total: number;
}): ReactElement {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      className="h-2 w-full overflow-hidden rounded-control bg-sunken"
    >
      <div
        className="h-full bg-ink transition-[width] duration-300 ease-out"
        style={{ width: `${String(percent)}%` }}
      />
    </div>
  );
}

function PreviewStep({
  preview,
  decisions,
  onDecide,
  undecided,
  replanned,
  planning,
  busy,
  onBack,
  onApply,
}: {
  preview: ImportPreview;
  decisions: Record<string, ImportDecision>;
  onDecide: (rowNumber: number, decision: ImportDecision) => void;
  undecided: boolean;
  replanned: boolean;
  /** The preview being taken again with the decisions, while it is. */
  planning: ImportPreviewRun | null;
  busy: boolean;
  onBack: () => void;
  onApply: () => void;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <section className="flex flex-col gap-4 rounded-panel border border-line bg-raised p-5 shadow-raised">
      <h2 id="import-preview-title" className="text-title">
        {t("import.preview.title")}
      </h2>
      <p className="text-body text-ink-muted">
        {t("import.preview.description")}
      </p>

      <dl className="flex flex-wrap gap-x-6 gap-y-1">
        {SUMMARY_KINDS.map((kind) => (
          <div key={kind} className="flex items-baseline gap-2">
            <dt className="text-label text-ink-muted uppercase">
              {t(OUTCOME_LABEL[kind])}
            </dt>
            <dd className={`font-data text-data ${OUTCOME_TONE[kind]}`}>
              {
                preview.rows.filter((row) => previewRowKind(row) === kind)
                  .length
              }
            </dd>
          </div>
        ))}
        <div className="flex items-baseline gap-2">
          <dt className="text-label text-ink-muted uppercase">
            {t("import.notInSource.label")}
          </dt>
          <dd className="font-data text-data text-ink-muted">
            {preview.notInSource.length}
          </dd>
        </div>
      </dl>

      {replanned ? (
        <Notice tone="warn" live>
          {t("import.preview.replanned")}
        </Notice>
      ) : null}

      {undecided ? (
        <Notice tone="warn">{t("import.preview.undecided")}</Notice>
      ) : null}

      <div className="overflow-x-auto">
        <table
          aria-labelledby="import-preview-title"
          className="w-full border-collapse"
        >
          <thead>
            <tr>
              <th scope="col" className={HEAD_CELL}>
                {t("import.preview.row")}
              </th>
              <th scope="col" className={HEAD_CELL}>
                {t("import.preview.outcome")}
              </th>
              <th scope="col" className={HEAD_CELL}>
                {t("import.preview.name")}
              </th>
              <th scope="col" className={HEAD_CELL}>
                {t("import.preview.apartment")}
              </th>
              <th scope="col" className={HEAD_CELL}>
                {t("import.preview.problems")}
              </th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row) => (
              <PreviewRow
                key={row.rowNumber}
                row={row}
                decision={decisions[String(row.rowNumber)]}
                onDecide={onDecide}
              />
            ))}
          </tbody>
        </table>
      </div>

      <NotInSourceList residencies={preview.notInSource} />

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy || undecided || planning !== null}
          onClick={onApply}
          className={PRIMARY_BUTTON}
        >
          {busy ? t("import.preview.applying") : t("import.preview.apply")}
        </button>
        <button type="button" onClick={onBack} className={SECONDARY_BUTTON}>
          {t("import.preview.back")}
        </button>
      </div>

      {planning === null ? null : <PlanningProgress planning={planning} />}
    </section>
  );
}

/** The summary's outcomes, in the order a board reads a file imported again. */
const SUMMARY_KINDS: readonly PreviewRowKind[] = [
  "create",
  "update",
  "matched",
  "ambiguous",
  "error",
];

/**
 * Who the register holds as living here that no row of the file reaches.
 *
 * Read-only on purpose. A file is somebody's list, and leaving a person out of
 * it is not a move-out: the board records one in the register when it has
 * happened, and the import writes none.
 */
function NotInSourceList({
  residencies,
}: {
  residencies: readonly ImportNotInSource[];
}): ReactElement {
  const { t } = useTranslation();

  return (
    <section
      aria-labelledby="import-not-in-source"
      className="flex flex-col gap-2 border-t border-line pt-4"
    >
      <h3 id="import-not-in-source" className="text-label uppercase">
        {t("import.notInSource.title")}
      </h3>
      <p className="text-body text-ink-muted">
        {t("import.notInSource.description")}
      </p>
      {residencies.length === 0 ? (
        <p className="text-body text-ink-muted">
          {t("import.notInSource.none")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table
            aria-labelledby="import-not-in-source"
            className="w-full border-collapse"
          >
            <thead>
              <tr>
                <th scope="col" className={HEAD_CELL}>
                  {t("import.preview.name")}
                </th>
                <th scope="col" className={HEAD_CELL}>
                  {t("import.preview.apartment")}
                </th>
                <th scope="col" className={HEAD_CELL}>
                  {t("import.preview.role")}
                </th>
                <th scope="col" className={HEAD_CELL}>
                  {t("import.field.movedInOn")}
                </th>
              </tr>
            </thead>
            <tbody>
              {residencies.map((residency) => (
                <tr
                  key={`${residency.personId}-${residency.apartment.id}-${residency.movedInOn}`}
                  className="border-t border-line"
                >
                  <td className={`${CELL} text-body text-ink`}>
                    {residency.name}
                  </td>
                  <td className={DATA_CELL}>
                    {`${residency.apartment.addressLabel} ${residency.apartment.number}`}
                  </td>
                  <td className={`${CELL} text-small text-ink`}>
                    {residency.role === "MEMBER"
                      ? t("moves.in.roleMember")
                      : t("moves.in.roleResident")}
                  </td>
                  <td className={DATA_CELL}>{residency.movedInOn}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PreviewRow({
  row,
  decision,
  onDecide,
}: {
  row: ImportPreviewRow;
  decision: ImportDecision | undefined;
  onDecide: (rowNumber: number, decision: ImportDecision) => void;
}): ReactElement {
  const { t } = useTranslation();

  const kind = previewRowKind(row);
  const decisionValue =
    decision === undefined
      ? ""
      : decision.action === "use-person"
        ? decision.personId
        : decision.action;

  return (
    <tr className="border-t border-line">
      <td className={DATA_CELL}>{row.sourceRow}</td>
      <td className={`${CELL} text-small ${OUTCOME_TONE[kind]}`}>
        <span className="flex flex-col gap-1">
          {t(OUTCOME_LABEL[kind])}
          {row.matchedBy === null ? null : (
            <span className="text-chip text-ink-muted uppercase">
              {`${t("import.preview.matchedBy")}: ${t(`import.matchedBy.${row.matchedBy}`)}`}
            </span>
          )}
          {row.matchedPersonName === null ? null : (
            // Who the row will be written to, so the board can see the match
            // is the person the row is about before anything is written.
            <span className="text-chip text-ink-muted">
              {`${t("import.preview.matchedPerson")}: ${row.matchedPersonName}`}
            </span>
          )}
          {row.fills.length === 0 ? null : (
            // What the update gives the person, so a row that changes the
            // register stands out from the many that agree with it.
            <span className="text-chip text-ink-muted">
              {`${t("import.preview.fills")}: ${row.fills
                .map((fill) => t(FILL_LABEL[fill]))
                .join(", ")}`}
            </span>
          )}
        </span>
      </td>
      <td className={`${CELL} text-body text-ink`}>
        <span className="flex flex-col gap-1">
          {`${row.person.firstName} ${row.person.lastName}`.trim()}
          {row.person.hasPersonalIdentityNumber ? (
            // Reported, never shown: a preview is not a register view.
            <span className="text-chip text-ink-muted uppercase">
              {t("import.preview.identityNumberOnFile")}
            </span>
          ) : null}
          {row.person.hasPersonalIdentityNumber &&
          (row.outcome === "update" || decision?.action === "use-person") &&
          row.matchedBy !== "personalIdentityNumber" ? (
            // The apply stores a number only on the person it identified, so
            // the board is not left thinking this one will be filled in - nor
            // the one it chose for a row that reached them some other way.
            <span className="text-chip text-ink-muted">
              {t("import.preview.identityNumberNotAdded")}
            </span>
          ) : null}
        </span>
      </td>
      <td className={DATA_CELL}>
        {row.apartment === null ? (
          <NotRecorded meaning={t("import.preview.noValue.apartment")} />
        ) : (
          `${row.apartment.addressLabel} ${row.apartment.number}`
        )}
      </td>
      <td className={`${CELL} text-small text-ink-muted`}>
        {row.outcome === "ambiguous" ? (
          <div className="flex flex-col gap-1">
            {row.mismatch === null ? null : (
              <span>{t(`import.mismatch.${row.mismatch}`)}</span>
            )}
            <label className="flex flex-col gap-1">
              <span className="text-chip uppercase">
                {t("import.preview.decision")}
              </span>
              <select
                value={decisionValue}
                onChange={(event) => {
                  const value = event.target.value;
                  onDecide(
                    row.rowNumber,
                    value === "create"
                      ? { action: "create" }
                      : value === "skip"
                        ? { action: "skip" }
                        : { action: "use-person", personId: value },
                  );
                }}
                className={FIELD}
              >
                <option value="" />
                {row.candidates.map((candidate) => (
                  <option key={candidate.personId} value={candidate.personId}>
                    {candidate.residencyConflict
                      ? t("import.preview.candidateResidencyConflict", {
                          name: candidate.name,
                        })
                      : candidate.name}
                  </option>
                ))}
                <option value="create">
                  {t("import.preview.decisionCreate")}
                </option>
                <option value="skip">{t("import.preview.decisionSkip")}</option>
              </select>
            </label>
            {row.candidates.some(
              (candidate) =>
                candidate.residencyConflict &&
                candidate.personId === decisionValue,
            ) ? (
              // Said beside the choice, because the apply would otherwise
              // count the row as a problem only once it is written.
              <span>{t("import.preview.decisionResidencyConflict")}</span>
            ) : null}
          </div>
        ) : row.problems.length === 0 ? (
          <NotRecorded meaning={t("import.preview.noValue.problems")} />
        ) : (
          <ul className="flex flex-col gap-1">
            {row.problems.map((problem) => (
              <li key={`${problem.field ?? ""}-${problem.reason}`}>
                {t(problemMessage(problem.reason))}
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

/**
 * The import, while it runs and once it has stopped.
 *
 * The same panel throughout, because it is the same import: the counts are what
 * the job has committed so far and go on rising, and what changes at the end is
 * only whether the import finished or stopped. A run that stopped says so and
 * says how far it got, rather than showing a tidy result that would suggest the
 * whole file was written.
 */
function ApplyStep({
  run,
  canAbandon,
  onAbandoned,
  onRestart,
}: {
  run: StartedImportRun;
  /** Whether the viewer may abandon a running import: an administrator. */
  canAbandon: boolean;
  onAbandoned: (run: ImportRunView) => void;
  onRestart: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [confirmingAbandon, setConfirmingAbandon] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  /** The reason the API refused the abandon, if it did. */
  const [abandonRefusal, setAbandonRefusal] = useState<string | null>(null);

  const running = isImportRunning(run.status);

  const abandon = async (): Promise<void> => {
    setAbandoning(true);
    setAbandonRefusal(null);
    const response = await abandonImport(run.sessionId);
    setAbandoning(false);
    setConfirmingAbandon(false);
    if (!response.ok) {
      setAbandonRefusal(response.failure.reason);
      return;
    }
    onAbandoned(response.value);
  };

  const counts = [
    ["import.result.personsCreated", run.result.personsCreated],
    ["import.result.personsUpdated", run.result.personsUpdated],
    ["import.result.residenciesCreated", run.result.residenciesCreated],
    [
      "import.result.memberRegisterEntriesCreated",
      run.result.memberRegisterEntriesCreated,
    ],
    ["import.result.skipped", run.result.skipped],
    ["import.result.errors", run.result.errors],
  ] as const;

  return (
    <section className="flex flex-col gap-4 rounded-panel border border-line bg-raised p-5 shadow-raised">
      <h2 className="text-title">{t(RUN_TITLE[run.status])}</h2>

      <p className="text-body text-ink-muted">
        {t("import.run.file", { fileName: run.fileName })}
      </p>

      <div className="flex flex-col gap-2">
        <ProgressBar
          label={t("import.run.progressLabel")}
          done={run.rowsDone}
          total={run.rowsTotal}
        />
        {/*
         * The state is written out beside the bar rather than left to the bar's
         * length: a bar that has stopped moving looks the same whether the
         * import finished, failed or is waiting for a worker.
         *
         * The state announces itself and the count does not. The state changes
         * three times in a whole import, which is worth interrupting a reader
         * for; the count changes every time the screen asks, and a live region
         * around it would read a new number aloud every second and a half. The
         * count is on the bar, where it is read when it is wanted.
         */}
        <p className="font-data text-data text-ink-muted">
          <span aria-live="polite">{t(RUN_STATUS_LABEL[run.status])}</span>
          <span>
            {` - ${t("import.run.progress", {
              done: run.rowsDone,
              total: run.rowsTotal,
            })}`}
          </span>
        </p>
      </div>

      {running ? (
        <Notice tone="info">{t("import.run.keepsGoing")}</Notice>
      ) : null}

      {/*
       * Only while it runs, and only for an administrator: the API refuses
       * everybody else, so offering the control would only produce a refusal.
       * Two presses rather than one, because it stops an import part way
       * through a register that cannot be edited.
       */}
      {running && canAbandon ? (
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <p className={HINT}>{t("import.abandon.description")}</p>
          {confirmingAbandon ? (
            <>
              <Notice tone="warn" live>
                {t("import.abandon.warning")}
              </Notice>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  disabled={abandoning}
                  onClick={() => {
                    void abandon();
                  }}
                  className={CAUTION_BUTTON}
                >
                  {abandoning
                    ? t("import.abandon.working")
                    : t("import.abandon.confirm")}
                </button>
                <button
                  type="button"
                  disabled={abandoning}
                  onClick={() => {
                    setConfirmingAbandon(false);
                  }}
                  className={SECONDARY_BUTTON}
                >
                  {t("import.abandon.cancel")}
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => {
                  setAbandonRefusal(null);
                  setConfirmingAbandon(true);
                }}
                className={CAUTION_BUTTON}
              >
                {t("import.abandon.start")}
              </button>
            </div>
          )}
        </div>
      ) : null}

      {/*
       * Outside the control, because the commonest refusal outlives it:
       * "session-not-running" is the import having ended on its own a moment
       * before the press, and the next poll brings that state in and takes the
       * control away. The notice stays to say why the press did nothing. That
       * one is information, not an error; anything else the press met is one.
       */}
      {abandonRefusal === null ? null : (
        <Notice
          tone={abandonRefusal === "session-not-running" ? "info" : "danger"}
          live
        >
          {t(failureMessage(abandonRefusal))}
        </Notice>
      )}

      {run.status === "FAILED" ? (
        <Notice tone="danger" live>
          {t(failureMessage(run.failureReason ?? ""))}
        </Notice>
      ) : null}

      <dl className="flex flex-wrap gap-x-6 gap-y-1">
        {counts.map(([key, value]) => (
          <div key={key} className="flex items-baseline gap-2">
            <dt className="text-label text-ink-muted uppercase">{t(key)}</dt>
            <dd className="font-data text-data text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      <Notice tone="info">{t("import.result.registerNotice")}</Notice>

      {running ? null : (
        <div className="flex flex-wrap gap-3">
          <Link to="/address-book" className={SECONDARY_BUTTON}>
            {t("import.result.toAddressBook")}
          </Link>
          <button
            type="button"
            onClick={onRestart}
            className={SECONDARY_BUTTON}
          >
            {t("import.run.another")}
          </button>
        </div>
      )}
    </section>
  );
}
