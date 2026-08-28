import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "../i18n";
import { SecurityPanel } from "./SecurityPanel";

/**
 * The second factor, as the panel reports it.
 *
 * The reported state is not cosmetic here. Pressing "enable" on an account that
 * already has an authenticator app issues a NEW secret and new backup codes, so
 * the entry already in the reader's authenticator stops working - a lockout on an
 * account that reaches the member register. The session that says whether TOTP is
 * enrolled resolves after the first render, so the panel has to follow it rather
 * than freeze whatever it was seeded with.
 */

vi.mock("../auth/auth-client", () => ({
  useSession: () => ({ data: undefined }),
  authClient: {
    passkey: {
      listUserPasskeys: () => Promise.resolve({ data: [] }),
    },
  },
}));

const stateWord = () => screen.getByText(/^(På|Av)$/).textContent;

describe("the authenticator app", () => {
  it("follows the session once it resolves", () => {
    // The first render is what useSession gives before it has an answer.
    const { rerender } = render(<SecurityPanel twoFactorEnabled={false} />);
    expect(stateWord()).toBe("Av");

    rerender(<SecurityPanel twoFactorEnabled />);

    expect(stateWord()).toBe("På");
  });

  it("offers disabling, not enabling, to an account that already has it", () => {
    const { rerender } = render(<SecurityPanel twoFactorEnabled={false} />);
    rerender(<SecurityPanel twoFactorEnabled />);

    // The button is the consequence: an "enable" here re-enrols and breaks the
    // authenticator entry the reader is already using.
    expect(screen.getByRole("button", { name: /^slå av$/i })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /slå på autentiseringsapp/i }),
    ).toBeNull();
  });
});
