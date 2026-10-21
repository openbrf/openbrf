import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { DomainError } from "../http/domain-error";
import { actionRefusal } from "./action-refusal";
import { ActionError, dispatchFailure, isRefusal } from "./action.error";

/**
 * Telling a refusal from a failure, which is what decides whether a confirmed
 * pending change may wait again (ADR 0039).
 *
 * A refusal wrote nothing; `internal` and `output-invalid` may have. The cases
 * that matter are the wrapped ones: a plugin's action that invoked another
 * receives the inner call's failure as the published refusal, and a refusal
 * that hands it on must not pass for one that wrote nothing.
 */

class SlugTaken extends DomainError {
  readonly reason = "slug-taken";
  readonly status = 409;
}

describe("isRefusal", () => {
  it("takes a check's refusal and a service's refusal for answers", () => {
    expect(isRefusal(new ActionError("forbidden-capability", "no"))).toBe(true);
    expect(isRefusal(new SlugTaken("taken"))).toBe(true);
    expect(isRefusal(actionRefusal(new SlugTaken("taken"), []))).toBe(true);
    expect(
      isRefusal(actionRefusal(new ActionError("read-only", "no"), [])),
    ).toBe(true);
    expect(
      isRefusal(actionRefusal(z.strictObject({}).safeParse(1).error, [])),
    ).toBe(true);
  });

  it.each(["internal", "output-invalid"] as const)(
    "takes %s for a failure, whether or not a plugin's action handed it on",
    (reason) => {
      const failed = new ActionError(reason, "broke");
      const wrapped = actionRefusal(failed, []);

      expect(isRefusal(failed)).toBe(false);
      expect(isRefusal(wrapped)).toBe(false);
      // A plugin's own refusal raised over it, carrying it as its cause.
      expect(isRefusal(new SlugTaken("taken", { cause: wrapped }))).toBe(false);
    },
  );

  it("takes anything that is not shaped like a refusal for a failure", () => {
    expect(isRefusal(new Error("database gone"))).toBe(false);
    expect(isRefusal("broke")).toBe(false);
  });
});

describe("dispatchFailure", () => {
  it.each(["internal", "output-invalid"] as const)(
    "names %s through every wrapping",
    (reason) => {
      const failed = new ActionError(reason, "broke");

      expect(dispatchFailure(failed)).toBe(reason);
      expect(dispatchFailure(actionRefusal(failed, []))).toBe(reason);
      expect(
        dispatchFailure(
          new SlugTaken("taken", { cause: actionRefusal(failed, []) }),
        ),
      ).toBe(reason);
    },
  );

  it("is null for a refusal, and for a cause chain that loops", () => {
    expect(dispatchFailure(new ActionError("read-only", "no"))).toBeNull();
    expect(
      dispatchFailure(actionRefusal(new SlugTaken("taken"), [])),
    ).toBeNull();

    const looped = new SlugTaken("taken");
    Object.defineProperty(looped, "cause", { value: looped });
    expect(dispatchFailure(looped)).toBeNull();
  });

  it("does not take a plugin's own reason for the registry's", () => {
    // A domain refusal that happens to be called `internal` is the service's
    // answer, not the registry's failure.
    class Internal extends DomainError {
      readonly reason = "internal";
      readonly status = 409;
    }
    expect(dispatchFailure(actionRefusal(new Internal("no"), []))).toBeNull();
  });
});
