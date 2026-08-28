import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { NotRecorded } from "../ui/NotRecorded";
import {
  applyImport,
  fetchActiveImport,
  fetchImportRun,
  type ImportDecision,
  type ImportField,
  IMPORT_FIELDS,
  IMPORT_TEMPLATE_URL,
  type ImportPreview,
  type ImportPreviewRow,
  type ImportRunView,
  type ImportSessionView,
  isImportRunning,
  previewImport,
  readFileAsBase64,
  type StartedImportRun,
  uploadImport,
} from "./import-api";
import {
  failureMessage,
  FIELD_LABEL,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  problemMessage,
  RUN_STATUS_LABEL,
  RUN_TITLE,
} from "./import-messages";

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
 * apartment.
 *
 * The fourth step is not this screen's work. Writing the register is a
 * background job, and the screen only watches it: it asks the API how far the
 * import has got and shows that. Which is also why closing the tab costs
 * nothing - the progress lives on the import itself, so the screen finds it
 * again by asking for the import that is running rather than by remembering
 * anything.
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

const CELL = "px-3 py-2 text-left align-top";
const HEAD_CELL = `${CELL} text-label uppercase text-ink-muted`;
const DATA_CELL = `${CELL} font-data text-data text-ink`;

export function ImportScreen(): ReactElement {
  const { t } = useTranslation();

  const [step, setStep] = useState<Step>("upload");
  const [session, setSession] = useState<ImportSessionView | null>(null);
  const [mapping, setMapping] = useState<(ImportField | null)[]>([]);
  const [defaultRole, setDefaultRole] = useState<"MEMBER" | "RESIDENT">(
    "MEMBER",
  );
  const [defaultMovedInOn, setDefaultMovedInOn] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, ImportDecision>>(
    {},
  );
  const [run, setRun] = useState<ImportRunView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<TranslationKey | null>(null);

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
   */
  useEffect(() => {
    let abandoned = false;

    void (async () => {
      const response = await fetchActiveImport();
      if (abandoned || !response.ok || response.value === null) {
        return;
      }
      setRun(response.value);
      setStep("apply");
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

  const upload = useCallback(async (file: File): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const content = await readFileAsBase64(file);
      const response = await uploadImport({ fileName: file.name, content });
      if (!response.ok) {
        setFailure(failureMessage(response.failure.reason));
        return;
      }
      setSession(response.value);
      setMapping(response.value.suggestedMapping);
      setPreview(null);
      setDecisions({});
      setStep("mapping");
    } catch {
      setFailure("import.errors.fileUnreadable");
    } finally {
      setBusy(false);
    }
  }, []);

  const runPreview = useCallback(async (): Promise<void> => {
    if (session === null) {
      return;
    }
    setBusy(true);
    setFailure(null);
    const response = await previewImport(session.sessionId, {
      mapping,
      defaultRole: needsDefaultRole ? defaultRole : null,
      defaultMovedInOn: needsDefaultMovedIn ? defaultMovedInOn : null,
    });
    setBusy(false);
    if (!response.ok) {
      setFailure(failureMessage(response.failure.reason));
      return;
    }
    setPreview(response.value);
    setDecisions({});
    setStep("preview");
  }, [
    session,
    mapping,
    needsDefaultRole,
    defaultRole,
    needsDefaultMovedIn,
    defaultMovedInOn,
  ]);

  const apply = useCallback(async (): Promise<void> => {
    if (session === null) {
      return;
    }
    setBusy(true);
    setFailure(null);
    const response = await applyImport(session.sessionId, { decisions });
    setBusy(false);
    if (!response.ok) {
      setFailure(failureMessage(response.failure.reason));
      if (response.failure.reason === "session-already-applied") {
        // Somebody was quicker - the other tab, or the other board member. What
        // this screen should show now is that import rather than a preview step
        // that is over.
        const started = await fetchActiveImport();
        if (started.ok && started.value !== null) {
          setRun(started.value);
          setStep("apply");
        }
      }
      return;
    }
    setRun(response.value);
    setStep("apply");
  }, [session, decisions]);

  const restart = useCallback((): void => {
    setRun(null);
    setSession(null);
    setPreview(null);
    setDecisions({});
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
          {t(failure)}
        </Notice>
      )}

      {step === "upload" ? <UploadStep busy={busy} onUpload={upload} /> : null}

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
          onBack={() => {
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
        <ApplyStep run={{ ...run, status: run.status }} onRestart={restart} />
      ) : null}
    </div>
  );
}

function UploadStep({
  busy,
  onUpload,
}: {
  busy: boolean;
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
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
            }}
            className={FIELD}
          />
        </label>
        <p className={HINT}>{t("import.upload.accept")}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || file === null}
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
  onBack: () => void;
  onSubmit: () => void;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <section className="flex flex-col gap-4 rounded-panel border border-line bg-raised p-5 shadow-raised">
      <h2 className="text-title">{t("import.mapping.title")}</h2>
      <p className="text-body text-ink-muted">
        {t("import.mapping.description")}
      </p>
      <p className="font-data text-data text-ink-muted">
        {t("import.mapping.fileSummary", {
          fileName: session.fileName,
          rows: session.rowCount,
          columns: session.columns.length,
        })}
      </p>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
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
        <fieldset className="flex flex-col gap-4 border-t border-line pt-4">
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
          disabled={busy || (needsDefaultMovedIn && defaultMovedInOn === "")}
          onClick={onSubmit}
          className={PRIMARY_BUTTON}
        >
          {busy ? t("import.mapping.working") : t("import.mapping.submit")}
        </button>
        <button type="button" onClick={onBack} className={SECONDARY_BUTTON}>
          {t("import.mapping.back")}
        </button>
      </div>
    </section>
  );
}

function PreviewStep({
  preview,
  decisions,
  onDecide,
  undecided,
  busy,
  onBack,
  onApply,
}: {
  preview: ImportPreview;
  decisions: Record<string, ImportDecision>;
  onDecide: (rowNumber: number, decision: ImportDecision) => void;
  undecided: boolean;
  busy: boolean;
  onBack: () => void;
  onApply: () => void;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <section className="flex flex-col gap-4 rounded-panel border border-line bg-raised p-5 shadow-raised">
      <h2 className="text-title">{t("import.preview.title")}</h2>
      <p className="text-body text-ink-muted">
        {t("import.preview.description")}
      </p>

      <dl className="flex flex-wrap gap-x-6 gap-y-1">
        {(["create", "update", "ambiguous", "error"] as const).map(
          (outcome) => (
            <div key={outcome} className="flex items-baseline gap-2">
              <dt className="text-label text-ink-muted uppercase">
                {t(OUTCOME_LABEL[outcome])}
              </dt>
              <dd className={`font-data text-data ${OUTCOME_TONE[outcome]}`}>
                {preview.summary[outcome]}
              </dd>
            </div>
          ),
        )}
      </dl>

      {undecided ? (
        <Notice tone="warn">{t("import.preview.undecided")}</Notice>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
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

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy || undecided}
          onClick={onApply}
          className={PRIMARY_BUTTON}
        >
          {busy ? t("import.preview.applying") : t("import.preview.apply")}
        </button>
        <button type="button" onClick={onBack} className={SECONDARY_BUTTON}>
          {t("import.preview.back")}
        </button>
      </div>
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

  const decisionValue =
    decision === undefined
      ? ""
      : decision.action === "use-person"
        ? decision.personId
        : decision.action;

  return (
    <tr className="border-t border-line">
      <td className={DATA_CELL}>{row.rowNumber}</td>
      <td className={`${CELL} text-small ${OUTCOME_TONE[row.outcome]}`}>
        <span className="flex flex-col gap-1">
          {t(OUTCOME_LABEL[row.outcome])}
          {row.matchedBy === null ? null : (
            <span className="text-chip text-ink-muted uppercase">
              {`${t("import.preview.matchedBy")}: ${t(`import.matchedBy.${row.matchedBy}`)}`}
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
        </span>
      </td>
      <td className={DATA_CELL}>
        {row.apartment === null ? (
          <NotRecorded />
        ) : (
          `${row.apartment.addressLabel} ${row.apartment.number}`
        )}
      </td>
      <td className={`${CELL} text-small text-ink-muted`}>
        {row.outcome === "ambiguous" ? (
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
                  {candidate.name}
                </option>
              ))}
              <option value="create">
                {t("import.preview.decisionCreate")}
              </option>
              <option value="skip">{t("import.preview.decisionSkip")}</option>
            </select>
          </label>
        ) : row.problems.length === 0 ? (
          <NotRecorded />
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
  onRestart,
}: {
  run: StartedImportRun;
  onRestart: () => void;
}): ReactElement {
  const { t } = useTranslation();

  const running = isImportRunning(run.status);
  const percent =
    run.rowsTotal === 0 ? 0 : Math.round((run.rowsDone / run.rowsTotal) * 100);

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
        <div
          role="progressbar"
          aria-label={t("import.run.progressLabel")}
          aria-valuemin={0}
          aria-valuemax={run.rowsTotal}
          aria-valuenow={run.rowsDone}
          className="h-2 w-full overflow-hidden rounded-control bg-sunken"
        >
          <div
            className="h-full bg-ink transition-[width] duration-300 ease-out"
            style={{ width: `${String(percent)}%` }}
          />
        </div>
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
          <Link to="/" className={SECONDARY_BUTTON}>
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
