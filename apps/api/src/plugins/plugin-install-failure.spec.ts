import { describe, expect, it } from "vitest";

import { ResourceFetchError } from "../packaging/fetch-resource";
import { verifySha512 } from "../packaging/integrity";
import { NpmInstallError } from "../packaging/npm-install";
import { InstallLockError } from "./install-lock";
import {
  PluginInstallError,
  pluginInstallFailure,
} from "./plugin-install-failure";

/**
 * What the install row records for each way a run can fail.
 *
 * The board reads the code and the values; the operator reads the cause. Each
 * case below is one of the failures the installer can actually meet, thrown
 * the way the code that meets it throws it, so a refusal that stops carrying
 * its values shows up here rather than as "{{status}}" on a board's screen.
 */

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  throw new Error("The call was expected to throw.");
}

describe("pluginInstallFailure", () => {
  it("keeps the code and values the installer gave its own refusal", () => {
    const failure = pluginInstallFailure(
      new PluginInstallError(
        "The plugin downloads used their 480000 ms before this one could start.",
        "download-budget-spent",
        { budgetMs: 480_000 },
      ),
      "download",
    );

    expect(failure).toEqual({
      reason: "download-budget-spent",
      detail: { budgetMs: 480_000 },
      cause:
        "PluginInstallError: The plugin downloads used their 480000 ms before this one could start.",
    });
  });

  it("reads a download that ran out of time as timed out, with its deadline", () => {
    const failure = pluginInstallFailure(
      new ResourceFetchError(
        "https://example.test/a.tgz did not finish within 300000 ms.",
        "unreachable",
        { timeoutMs: 300_000 },
      ),
      "download",
    );

    expect(failure.reason).toBe("download-timed-out");
    expect(failure.detail).toEqual({ timeoutMs: 300_000 });
  });

  it("reads an error status as the status the host answered", () => {
    const failure = pluginInstallFailure(
      new ResourceFetchError(
        "https://example.test/a.tgz answered 404.",
        "unreachable",
        { status: 404 },
      ),
      "download",
    );

    expect(failure.reason).toBe("source-answered-error");
    expect(failure.detail).toEqual({ status: 404 });
  });

  it("reads a host that never answered as unreachable", () => {
    const failure = pluginInstallFailure(
      new ResourceFetchError(
        "https://example.test/a.tgz could not be reached.",
        "unreachable",
      ),
      "download",
    );

    expect(failure.reason).toBe("source-unreachable");
    expect(failure.detail).toEqual({});
  });

  it("reads a refused scheme as a source this instance does not read", () => {
    const failure = pluginInstallFailure(
      new ResourceFetchError(
        "http: is not an allowed source; use https:.",
        "unsupported-scheme",
      ),
      "download",
    );

    expect(failure.reason).toBe("source-not-allowed");
  });

  it("reads an oversized archive with the cap it went over", () => {
    const failure = pluginInstallFailure(
      new ResourceFetchError(
        "https://example.test/a.tgz is over the 67108864 byte limit.",
        "too-large",
        { maxBytes: 67_108_864 },
      ),
      "download",
    );

    expect(failure.reason).toBe("archive-too-large");
    expect(failure.detail).toEqual({ maxBytes: 67_108_864 });
  });

  it("reads bytes that do not match the catalog as a checksum mismatch", () => {
    const declared = `sha512-${Buffer.alloc(64).toString("base64")}`;
    const failure = pluginInstallFailure(
      thrown(() => {
        verifySha512(Buffer.from("not what was published"), declared);
      }),
      "download",
    );

    expect(failure.reason).toBe("checksum-mismatch");
    // The digests are the operator's to compare, and stay in the cause.
    expect(failure.detail).toEqual({});
    expect(failure.cause).toContain("Digest mismatch");
  });

  it("reads a checksum the catalog wrote wrongly as malformed", () => {
    const failure = pluginInstallFailure(
      thrown(() => {
        verifySha512(Buffer.from("anything"), "md5-abc");
      }),
      "download",
    );

    expect(failure.reason).toBe("checksum-malformed");
  });

  it("reads a failed npm run as such", () => {
    const failure = pluginInstallFailure(
      new NpmInstallError(
        "npm install failed while staging the installation.",
        "npm ERR! code ENOTCACHED",
      ),
      "build",
    );

    expect(failure.reason).toBe("npm-install-failed");
  });

  it("reads a claim taken over mid-build as lost", () => {
    const failure = pluginInstallFailure(
      new InstallLockError(
        "The claim on the plugin installation at /data/plugins/.install-lock was taken over by another run.",
      ),
      "build",
    );

    expect(failure.reason).toBe("installation-claim-lost");
  });

  it.each([
    ["download", "download-failed"],
    ["build", "build-failed"],
  ] as const)(
    "records anything else in the %s phase under that phase's general code",
    (phase, reason) => {
      const failure = pluginInstallFailure(
        new Error("ENOSPC: no space left on device"),
        phase,
      );

      expect(failure).toEqual({
        reason,
        detail: {},
        cause: "Error: ENOSPC: no space left on device",
      });
    },
  );
});
