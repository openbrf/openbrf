import { describe, expect, it } from "vite-plus/test";

import type { RequestWithPrincipal } from "./authorization.guard";
import type { Principal } from "./capabilities";
import { requirePersonId, requirePrincipal } from "./require-principal";

describe("requirePrincipal", () => {
  it("returns the principal the guard attached", () => {
    const principal = { personId: "person-1" } as Principal;
    const request = { principal } as RequestWithPrincipal;

    expect(requirePrincipal(request)).toBe(principal);
    expect(requirePersonId(request)).toBe("person-1");
  });

  it("fails naming the guard when no principal is attached", () => {
    const request = {} as RequestWithPrincipal;

    expect(() => requirePersonId(request)).toThrow(
      "The authorization guard did not attach a principal.",
    );
  });
});
