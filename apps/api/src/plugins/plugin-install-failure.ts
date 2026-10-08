import { IntegrityError } from "@openbrf/plugin-sdk";
import type {
  PluginInstallFailureDetail,
  PluginInstallFailureReason,
} from "@openbrf/shared";

import { ResourceFetchError } from "../packaging/fetch-resource";
import { NpmInstallError } from "../packaging/npm-install";
import { InstallLockError } from "./install-lock";

/**
 * Why an install did not converge, as the row records it.
 *
 * `reason` and `detail` are what the board reads, translated where they are
 * shown; `cause` is what was thrown, in the server's own English, for whoever
 * operates the instance. Kept apart so neither has to be read out of the other:
 * a sentence parsed back into a code breaks the first time its wording is
 * improved.
 */
export interface PluginInstallFailure {
  reason: PluginInstallFailureReason;
  detail: PluginInstallFailureDetail;
  cause: string;
}

/**
 * A refusal the installer itself makes, carrying its code.
 *
 * Thrown where the message is composed, so the code and the English beside it
 * are written once and together rather than matched up afterwards.
 */
export class PluginInstallError extends Error {
  constructor(
    message: string,
    readonly reason: PluginInstallFailureReason,
    readonly detail: PluginInstallFailureDetail = {},
  ) {
    super(message);
    this.name = "PluginInstallError";
  }
}

/**
 * Which half of a run failed, and so which code a cause with none of its own
 * is recorded under. The download and the build fail for different reasons
 * and are fixed in different places, so even the fallback says which.
 */
export type PluginInstallPhase = "download" | "build";

/**
 * Turns whatever a run threw into the failure the row records.
 *
 * Total: an error this function does not recognise is recorded under the
 * phase's general code, with what it said kept as the cause, rather than
 * leaving the row with no reason at all.
 */
export function pluginInstallFailure(
  thrown: unknown,
  phase: PluginInstallPhase,
): PluginInstallFailure {
  const cause = String(thrown);

  if (thrown instanceof PluginInstallError) {
    return { reason: thrown.reason, detail: thrown.detail, cause };
  }

  if (thrown instanceof ResourceFetchError) {
    return { ...fetchFailure(thrown), cause };
  }

  if (thrown instanceof IntegrityError) {
    return {
      reason:
        thrown.reason === "digest-mismatch"
          ? "checksum-mismatch"
          : "checksum-malformed",
      detail: {},
      cause,
    };
  }

  if (thrown instanceof NpmInstallError) {
    return { reason: "npm-install-failed", detail: {}, cause };
  }

  // The only claim a run can lose mid-build: acquiring one happens before the
  // reconcile reads a single row, so its failure never reaches one.
  if (thrown instanceof InstallLockError) {
    return { reason: "installation-claim-lost", detail: {}, cause };
  }

  return {
    reason: phase === "download" ? "download-failed" : "build-failed",
    detail: {},
    cause,
  };
}

function fetchFailure(
  error: ResourceFetchError,
): Omit<PluginInstallFailure, "cause"> {
  switch (error.reason) {
    case "unsupported-scheme":
      return { reason: "source-not-allowed", detail: {} };
    case "too-large":
      return {
        reason: "archive-too-large",
        detail:
          error.detail.maxBytes === undefined
            ? {}
            : { maxBytes: error.detail.maxBytes },
      };
    case "unreachable":
      if (error.detail.timeoutMs !== undefined) {
        return {
          reason: "download-timed-out",
          detail: { timeoutMs: error.detail.timeoutMs },
        };
      }
      if (error.detail.status !== undefined) {
        return {
          reason: "source-answered-error",
          detail: { status: error.detail.status },
        };
      }
      return { reason: "source-unreachable", detail: {} };
  }
}
