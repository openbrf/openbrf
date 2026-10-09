import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { SmsSettings } from "../api/instance";
import { SmsPanel } from "./SmsPanel";

/**
 * The SMS form.
 *
 * The credential is guarded the way the SMTP password is: the API never returns
 * it, so the field is always empty on load, and an empty field therefore has to
 * mean "keep what is stored" rather than "clear it".
 *
 * The other thing worth holding is what the panel says when nothing is set up.
 * An association with no SMS provider is not broken - it reaches its members by
 * email - and the notice has to say that rather than read as a fault.
 */

const saveSms = vi.fn();
const sendSmsTest = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  saveSms: (input: unknown) => saveSms(input),
  sendSmsTest: () => sendSmsTest(),
}));

const CONFIGURED: SmsSettings = {
  driver: "http-gateway",
  gatewayUrl: "https://gateway.exempel.se/send",
  senderName: "Ekhagen",
  tokenSet: true,
  configured: true,
};

const EMPTY: SmsSettings = {
  driver: null,
  gatewayUrl: null,
  senderName: null,
  tokenSet: false,
  configured: false,
};

const save = async (session: ReturnType<typeof userEvent.setup>) => {
  await session.click(screen.getByRole("button", { name: /^spara$/i }));
};

beforeEach(() => {
  saveSms.mockReset().mockResolvedValue({ ok: true, value: CONFIGURED });
  sendSmsTest
    .mockReset()
    .mockResolvedValue({ ok: true, value: { sentTo: "+46701234567" } });
});

describe("the stored gateway credential", () => {
  it("is never rendered back into the form", () => {
    render(<SmsPanel value={CONFIGURED} />);

    expect(
      (screen.getByLabelText(/^gatewaynyckel/i) as HTMLInputElement).value,
    ).toBe("");
  });

  it("is kept when the field is left empty", async () => {
    const session = userEvent.setup();
    render(<SmsPanel value={CONFIGURED} />);

    await save(session);

    await waitFor(() => {
      expect(saveSms).toHaveBeenCalled();
    });
    // Absent, not null: null would clear it.
    expect(saveSms.mock.calls[0]?.[0]).toMatchObject({
      driver: "http-gateway",
      token: undefined,
    });
  });

  it("is cleared only when that is asked for explicitly", async () => {
    const session = userEvent.setup();
    render(<SmsPanel value={CONFIGURED} />);

    await session.click(screen.getByLabelText(/ta bort den sparade nyckeln/i));
    await save(session);

    await waitFor(() => {
      expect(saveSms).toHaveBeenCalledWith(
        expect.objectContaining({ token: null }),
      );
    });
  });

  it("offers no clear control when there is nothing stored", () => {
    render(<SmsPanel value={EMPTY} />);

    expect(screen.queryByLabelText(/ta bort den sparade nyckeln/i)).toBeNull();
  });
});

describe("an instance with no SMS provider", () => {
  it("says so as a state rather than as a fault", () => {
    // Not a fault. Text messages are an addition an association pays for, and
    // the notice reads as a state rather than as something broken. It says
    // nothing about email: whether that is set up is the email panel's answer
    // to give, and this panel has not asked.
    render(<SmsPanel value={EMPTY} />);

    expect(screen.getByText(/kan inte sms:as/i)).toBeTruthy();
    expect(screen.queryByText(/når dem med e-post/i)).toBeNull();
  });

  it("cannot send a test before there is a gateway to send through", () => {
    render(<SmsPanel value={EMPTY} />);

    expect(
      screen.getByRole("button", { name: /testmeddelande/i }),
    ).toHaveProperty("disabled", true);
  });
});

describe("choosing a provider", () => {
  it("turns SMS off entirely when the driver is set back to none", async () => {
    const session = userEvent.setup();
    render(<SmsPanel value={CONFIGURED} />);

    await session.selectOptions(screen.getByLabelText(/^leverantör/i), "");
    await save(session);

    await waitFor(() => {
      expect(saveSms).toHaveBeenCalledWith(
        expect.objectContaining({ driver: null }),
      );
    });
  });

  it("sends the gateway address the board typed", async () => {
    const session = userEvent.setup();
    render(<SmsPanel value={EMPTY} />);

    await session.selectOptions(
      screen.getByLabelText(/^leverantör/i),
      "http-gateway",
    );
    await session.type(
      screen.getByLabelText(/^gatewayadress/i),
      "https://gateway.exempel.se/send",
    );
    await save(session);

    await waitFor(() => {
      expect(saveSms).toHaveBeenCalledWith(
        expect.objectContaining({
          driver: "http-gateway",
          gatewayUrl: "https://gateway.exempel.se/send",
        }),
      );
    });
  });

  it("names the field the API refused rather than asking for a retry", async () => {
    // An ftp:// address passes the browser's url check and never the API's.
    saveSms.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        reason: "invalid-body",
        detail: [{ path: "gatewayUrl", message: "Invalid URL" }],
      },
    });
    const session = userEvent.setup();
    render(<SmsPanel value={CONFIGURED} />);

    await save(session);

    await waitFor(() => {
      expect(screen.getByText(/^Gatewayadress godtogs inte/)).toBeTruthy();
    });
  });

  it("says a gateway on a private network is not one this instance reaches", async () => {
    saveSms.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "host-not-public" },
    });
    const session = userEvent.setup();
    render(<SmsPanel value={CONFIGURED} />);

    await save(session);

    await waitFor(() => {
      expect(screen.getByText(/kan inte ansluta till gatewayen/i)).toBeTruthy();
    });
  });
});

describe("the test message", () => {
  it("names the number the gateway actually sent to", async () => {
    const session = userEvent.setup();
    render(<SmsPanel value={CONFIGURED} />);

    await session.click(
      screen.getByRole("button", { name: /testmeddelande/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/\+46701234567/)).toBeTruthy();
    });
  });

  it("explains a refusal in its own words", async () => {
    sendSmsTest.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "no-phone" },
    });
    const session = userEvent.setup();
    render(<SmsPanel value={CONFIGURED} />);

    await session.click(
      screen.getByRole("button", { name: /testmeddelande/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/saknar ett telefonnummer/i)).toBeTruthy();
    });
  });
});

describe("a board member who may only read", () => {
  it("gets the fields disabled and no save button", () => {
    render(<SmsPanel value={CONFIGURED} editable={false} />);

    expect(screen.getByLabelText(/^leverantör/i)).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.queryByRole("button", { name: /^spara$/i })).toBeNull();
  });
});

describe("while the SMS settings are being saved", () => {
  /** Holds the request open, so the form is observed mid-save. */
  function holdRequest(): (outcome: unknown) => void {
    let settle: (outcome: unknown) => void = () => undefined;
    saveSms.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    return (outcome) => {
      settle(outcome);
    };
  }

  const OUTCOMES = [
    ["once it is stored", { ok: true, value: CONFIGURED }],
    [
      "when it is refused",
      { ok: false, failure: { status: 500, reason: "unknown" } },
    ],
  ] as const;

  it("locks the form, so nothing typed is lost when the token is cleared", async () => {
    const session = userEvent.setup();
    const settle = holdRequest();
    render(<SmsPanel value={CONFIGURED} />);

    const secret = screen.getByLabelText<HTMLInputElement>(/^gatewaynyckel/i);
    const other = screen.getByLabelText<HTMLInputElement>(/^avsändarnamn/i);
    await session.type(secret, "hemligt");
    expect(secret.matches(":disabled")).toBe(false);

    await save(session);

    // The request is in flight: the fields refuse input rather than taking it
    // and dropping it once the save is stored.
    await waitFor(() => {
      expect(secret.matches(":disabled")).toBe(true);
    });
    expect(other.matches(":disabled")).toBe(true);
    await session.type(secret, "9");
    await session.type(other, "x");
    expect(secret.value).toBe("hemligt");
    expect(other.value).toBe("Ekhagen");

    settle({ ok: true, value: CONFIGURED });

    await waitFor(() => {
      expect(secret.matches(":disabled")).toBe(false);
    });
    expect(secret.value).toBe("");
    expect(other.value).toBe("Ekhagen");
  });

  it.each(OUTCOMES)(
    "keeps focus in the token field after Enter, %s",
    async (_case, outcome) => {
      const session = userEvent.setup();
      const settle = holdRequest();
      render(<SmsPanel value={CONFIGURED} />);

      const secret = screen.getByLabelText<HTMLInputElement>(/^gatewaynyckel/i);
      await session.type(secret, "hemligt{Enter}");

      await waitFor(() => {
        expect(secret.matches(":disabled")).toBe(true);
      });
      // A browser drops focus to the page when the focused control is
      // disabled; jsdom leaves it where it was. So the hand-back is watched
      // as well as the outcome.
      const refocus = vi.spyOn(secret, "focus");

      settle(outcome);

      // The hand-back runs in an effect after the field is enabled again, so it is
      // awaited together with the enabled state.
      await waitFor(() => {
        expect(secret.matches(":disabled")).toBe(false);
        expect(refocus).toHaveBeenCalledTimes(1);
        expect(document.activeElement).toBe(secret);
      });
    },
  );
});
