import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { formatMoment } from "../ui/moment";
import { Notice } from "../ui/Notice";
import { TwoPressConfirm } from "../ui/TwoPressConfirm";
import {
  fetchImportProposals,
  type ImportProposalState,
  type ImportProposalView,
  rejectImportProposal,
} from "./import-api";
import { failureMessage } from "./import-messages";

/**
 * Member lists plugins have handed the board to review (ADR 0043).
 *
 * A plugin - one that receives the list by email, say - only proposes. Its
 * file waits here, at the top of the import screen, and is opened at the
 * mapping step like a file the board uploaded: the board previews it, decides
 * and applies it, or rejects it. Nothing of it reaches the register before
 * that.
 *
 * The sender is stated as the plugin reported it, and named as such: the
 * plugin's source knows who sent the file, and it can be wrong or deceived
 * about it. The decided proposals are listed below the waiting ones, as the
 * run history of each plugin's files.
 */

/**
 * Whether a refusal says the proposal had ended or started some other way: the
 * list as it is re-read shows that, and the notice has nothing to add.
 */
function endedByNow(reason: string): boolean {
  return (
    reason.startsWith("proposal-") ||
    reason === "session-not-found" ||
    reason === "session-already-applied"
  );
}

const STATE_LABEL: Readonly<Record<ImportProposalState, TranslationKey>> = {
  pending: "import.proposals.state.pending",
  applying: "import.proposals.state.applying",
  applied: "import.proposals.state.applied",
  failed: "import.proposals.state.failed",
  rejected: "import.proposals.state.rejected",
  superseded: "import.proposals.state.superseded",
  expired: "import.proposals.state.expired",
  withdrawn: "import.proposals.state.withdrawn",
};

/** The plugin's name as the board knows it: the package, or the id. */
export function proposingPlugin(proposal: ImportProposalView): string {
  return proposal.plugin.name ?? proposal.plugin.id;
}

type Proposals =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "loaded"; proposals: ImportProposalView[] };

export function ImportProposals({
  readOnly,
  busy,
  version,
  onOpen,
}: {
  /** Whether nothing may be sent: a support session, read only. */
  readOnly: boolean;
  /** Whether the screen is already opening one. */
  busy: boolean;
  /**
   * Changed by the screen when what it knows of the list is out of date: a
   * proposal it tried to open had ended meanwhile.
   */
  version: number;
  onOpen: (proposalId: string) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  const [state, setState] = useState<Proposals>({ kind: "loading" });
  const [reading, setReading] = useState(0);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectBusy, setRejectBusy] = useState(false);
  const [rejectFailure, setRejectFailure] = useState<string | null>(null);

  useEffect(() => {
    const leaving = new AbortController();
    void (async () => {
      const response = await fetchImportProposals(leaving.signal);
      if (leaving.signal.aborted) {
        return;
      }
      if (response.ok) {
        // The list now shows what became of the proposal, which is what a
        // refusal that it had ended said. Any other refusal stays: the list
        // does not tell whether the rejection went through.
        setRejectFailure((reason) =>
          reason !== null && endedByNow(reason) ? null : reason,
        );
      }
      setState(
        response.ok
          ? { kind: "loaded", proposals: response.value.proposals }
          : { kind: "failed" },
      );
    })();
    return () => {
      leaving.abort();
    };
  }, [reading, version]);

  const reread = useCallback((): void => {
    setReading((count) => count + 1);
  }, []);

  const reject = useCallback(
    async (proposalId: string): Promise<void> => {
      setRejectBusy(true);
      setRejectFailure(null);
      const response = await rejectImportProposal(proposalId);
      setRejectBusy(false);
      setRejecting(null);
      if (!response.ok) {
        setRejectFailure(response.failure.reason);
      }
      // Rejected, or ended or started some other way meanwhile: either way
      // the list as it is now is the one to show.
      reread();
    },
    [reread],
  );

  if (state.kind === "loading") {
    return null;
  }
  if (state.kind === "failed") {
    return (
      <Notice tone="danger">
        {t("import.proposals.loadFailed")}{" "}
        <button type="button" onClick={reread} className={SECONDARY_BUTTON}>
          {t("app.retry")}
        </button>
      </Notice>
    );
  }

  const waiting = state.proposals.filter(
    (proposal) => proposal.state === "pending",
  );
  const decided = state.proposals.filter(
    (proposal) => proposal.state !== "pending",
  );
  if (waiting.length === 0 && decided.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby="import-proposals-title"
      className="flex flex-col gap-4 rounded-panel border border-line bg-raised p-5 shadow-raised"
    >
      <h2 id="import-proposals-title" className="text-title">
        {t("import.proposals.title")}
      </h2>
      <p className="text-body text-ink-muted">
        {t("import.proposals.description")}
      </p>

      {rejectFailure === null ? null : (
        <Notice tone="danger" live>
          {t(failureMessage(rejectFailure))}
        </Notice>
      )}

      {waiting.length === 0 ? (
        <p className="text-body text-ink-muted">{t("import.proposals.none")}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {waiting.map((proposal) => (
            <li
              key={proposal.proposalId}
              className="flex flex-col gap-2 border-t border-line pt-4 first:border-t-0 first:pt-0"
            >
              <ProposalSummary proposal={proposal} />
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={busy || rejectBusy || readOnly}
                  aria-label={t("import.proposals.openLabel", {
                    fileName: proposal.fileName,
                  })}
                  onClick={() => {
                    onOpen(proposal.proposalId);
                  }}
                  className={PRIMARY_BUTTON}
                >
                  {t("import.proposals.open")}
                </button>
                <TwoPressConfirm
                  confirming={rejecting === proposal.proposalId}
                  busy={rejectBusy}
                  askDisabled={busy || rejectBusy || readOnly}
                  askText={t("import.proposals.reject")}
                  askLabel={t("import.proposals.rejectLabel", {
                    fileName: proposal.fileName,
                  })}
                  askClassName={SECONDARY_BUTTON}
                  confirmText={t("import.proposals.rejectConfirm")}
                  keepText={t("import.proposals.rejectKeep")}
                  onAsk={() => {
                    setRejecting(proposal.proposalId);
                  }}
                  onConfirm={() => {
                    void reject(proposal.proposalId);
                  }}
                  onKeep={() => {
                    setRejecting(null);
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {decided.length === 0 ? null : <DecidedProposals proposals={decided} />}
    </section>
  );
}

/**
 * Who proposed the file, what it is and where it came from: shown on the
 * list and again over the mapping step, so the board knows whose file it is
 * mapping.
 */
export function ProposalSummary({
  proposal,
}: {
  proposal: ImportProposalView;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const plugin = proposingPlugin(proposal);

  return (
    <div className="flex flex-col gap-1">
      <p className="text-body font-semibold text-ink">
        {t("import.proposals.proposedBy", { plugin })}
      </p>
      <p className="font-data text-data text-ink">
        {t("import.proposals.file", {
          fileName: proposal.fileName,
          count: proposal.rowCount,
        })}
      </p>
      <p className="text-small text-ink-muted">
        {proposal.sender === null
          ? t("import.proposals.noSender", { plugin })
          : t("import.proposals.sender", { sender: proposal.sender, plugin })}
      </p>
      <p className="text-small text-ink-muted">
        {t("import.proposals.arrived", {
          arrivedAt: formatMoment(proposal.proposedAt, i18n.language),
          expiresAt: formatMoment(proposal.expiresAt, i18n.language),
        })}
      </p>
    </div>
  );
}

function DecidedProposals({
  proposals,
}: {
  proposals: readonly ImportProposalView[];
}): ReactElement {
  const { t, i18n } = useTranslation();

  return (
    <details className="flex flex-col gap-2 border-t border-line pt-4">
      <summary className="min-h-11 cursor-pointer py-2 text-body font-semibold text-ink">
        {t("import.proposals.history", { count: proposals.length })}
      </summary>
      <ul className="mt-3 flex flex-col gap-2">
        {proposals.map((proposal) => (
          <li
            key={proposal.proposalId}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-small text-ink-muted"
          >
            <span className="font-data text-data text-ink">
              {proposal.fileName}
            </span>
            <span>
              {t("import.proposals.historyFrom", {
                plugin: proposingPlugin(proposal),
                count: proposal.rowCount,
              })}
            </span>
            {proposal.sender === null ? null : (
              <span>
                {t("import.proposals.historySender", {
                  sender: proposal.sender,
                })}
              </span>
            )}
            <span className="font-semibold text-ink">
              {t(STATE_LABEL[proposal.state])}
            </span>
            {proposal.decidedAt === null ? null : (
              <span className="font-data text-data">
                {formatMoment(proposal.decidedAt, i18n.language)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
