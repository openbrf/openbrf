import { describe, expect, it } from "vitest";

import { prefix } from "./prefix";

describe("prefix", () => {
  it("leaves text no longer than the limit as it is", () => {
    expect(prefix("abc", 3)).toBe("abc");
  });

  it("cuts longer text to the limit", () => {
    expect(prefix("abcdef", 3)).toBe("abc");
  });

  it("stops one short rather than split a surrogate pair", () => {
    expect(prefix("ab😀c", 3)).toBe("ab");
  });

  it("keeps a surrogate pair that ends right at the limit", () => {
    expect(prefix("a😀bc", 3)).toBe("a😀");
  });
});
