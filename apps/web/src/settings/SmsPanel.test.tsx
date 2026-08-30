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
  it("says the members are reached by email in the meantime", () => {
    // Not a fault. Text messages are an addition an association pays for, and
    // the notice reads as a state rather than as something broken.
    render(<SmsPanel value={EMPTY} />);

    expect(screen.getByText(/når dem med e-post/i)).toBeTruthy();
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
