import { describe, expect, it } from "vite-plus/test";

import {
  ACTION_ERROR_MCP,
  ACTION_ERROR_REASONS,
  isActionRefusal,
} from "./action-refusal.ts";

/**
 * The guard a plugin recognises a refused call with.
 *
 * The host builds the refusal from its own class, and the plugin's copy of this
 * package is bundled with the plugin, so `instanceof` cannot work across the
 * two. What these tests protect is that the structural test accepts every
 * refusal the host can raise and nothing that merely looks like one: a
 * connector that took an arbitrary error for a refusal would tell a model a
 * fault was an answer, and one that missed a refusal would answer a
 * recoverable mistake as an internal error.
 */

function refusal(fields: Record<string, unknown>): Error {
  return Object.assign(new Error("Refused."), {
    name: "ActionRefusal",
    status: 403,
    transport: "tool-result",
    retry: "never",
    details: () => ({}),
    ...fields,
  });
}

describe("isActionRefusal", () => {
  it.each(ACTION_ERROR_REASONS)(
    "recognises the registry's %s refusal",
    (reason) => {
      expect(
        isActionRefusal(
          refusal({ kind: "registry", reason, ...ACTION_ERROR_MCP[reason] }),
        ),
      ).toBe(true);
    },
  );

  it("recognises an invalid body", () => {
    expect(
      isActionRefusal(
        refusal({
          kind: "invalid-body",
          reason: "invalid-body",
          status: 400,
          ...ACTION_ERROR_MCP["invalid-body"],
        }),
      ),
    ).toBe(true);
  });

  it("recognises a domain refusal under the service's own reason", () => {
    // The reason is the one the action declared in its errors, which the
    // registry has no list of, so any string passes here.
    expect(
      isActionRefusal(
        refusal({ kind: "domain", reason: "slug-taken", retry: "after-edit" }),
      ),
    ).toBe(true);
  });

  it("recognises a challenge carried on the refusal", () => {
    expect(
      isActionRefusal(
        refusal({
          kind: "registry",
          reason: "insufficient-scope",
          challenge: 'Bearer error="insufficient_scope"',
        }),
      ),
    ).toBe(true);
  });

  it("refuses a registry reason the registry does not raise", () => {
    expect(
      isActionRefusal(refusal({ kind: "registry", reason: "slug-taken" })),
    ).toBe(false);
  });

  it("refuses an invalid body under any other reason", () => {
    expect(
      isActionRefusal(refusal({ kind: "invalid-body", reason: "internal" })),
    ).toBe(false);
  });

  it.each([
    ["an unknown kind", { kind: "plugin", reason: "x" }],
    [
      "an unknown transport",
      { kind: "domain", reason: "x", transport: "http" },
    ],
    [
      "an unknown retry verdict",
      { kind: "domain", reason: "x", retry: "soon" },
    ],
    [
      "a status that is not a number",
      { kind: "domain", reason: "x", status: "403" },
    ],
    [
      "particulars that are not a function",
      { kind: "domain", reason: "x", details: {} },
    ],
    [
      "a challenge that is not a string",
      { kind: "domain", reason: "x", challenge: 1 },
    ],
    ["another name", { kind: "domain", reason: "x", name: "ActionError" }],
  ])("refuses %s", (_label, fields) => {
    expect(isActionRefusal(refusal(fields))).toBe(false);
  });

  it("refuses a plain object shaped like a refusal", () => {
    // Thrown values that are not errors carry no stack, and a host that threw
    // one would be broken in a way a connector should not paper over.
    expect(
      isActionRefusal({
        name: "ActionRefusal",
        kind: "domain",
        reason: "x",
        status: 409,
        transport: "tool-result",
        retry: "never",
        details: () => ({}),
      }),
    ).toBe(false);
  });

  it.each([null, undefined, "ActionRefusal", 403, new Error("boom")])(
    "refuses %s",
    (value) => {
      expect(isActionRefusal(value)).toBe(false);
    },
  );
});

describe("ACTION_ERROR_MCP", () => {
  it("renders every registry reason and both refusals that are not its own", () => {
    expect(Object.keys(ACTION_ERROR_MCP).sort()).toEqual(
      [...ACTION_ERROR_REASONS, "invalid-body", "domain"].sort(),
    );
  });
});
