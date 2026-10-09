import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type {
  EnvironmentMailSettings,
  StoredSmtpSettings,
} from "../api/instance";
import { SmtpPanel } from "./SmtpPanel";

/**
 * The SMTP form.
 *
 * The password is the part worth guarding. The API never returns it, so the
 * field is always empty on load, and an empty field therefore has to mean "keep
 * what is stored" rather than "clear it" - otherwise saving a changed port
 * would silently break every invitation the instance sends.
 */

const saveSmtp = vi.fn();
const sendSmtpTest = vi.fn();

vi.mock("../api/instance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instance")>()),
  saveSmtp: (input: unknown) => saveSmtp(input),
  sendSmtpTest: () => sendSmtpTest(),
}));

const CONFIGURED: StoredSmtpSettings = {
  source: "settings",
  host: "smtp.example.se",
  port: 587,
  secure: true,
  user: "styrelsen",
  fromAddress: "styrelsen@exempel.se",
  passwordSet: true,
  tlsOptional: false,
  configured: true,
};

const EMPTY: StoredSmtpSettings = {
  source: "settings",
  host: null,
  port: null,
  secure: true,
  user: null,
  fromAddress: null,
  passwordSet: false,
  tlsOptional: false,
  configured: false,
};

const save = async (session: ReturnType<typeof userEvent.setup>) => {
  await session.click(screen.getByRole("button", { name: /^spara$/i }));
};

beforeEach(() => {
  saveSmtp.mockReset().mockResolvedValue({ ok: true, value: CONFIGURED });
  sendSmtpTest.mockReset().mockResolvedValue({
    ok: true,
    value: { sentTo: "holger@exempel.se", host: "smtp.example.se" },
  });
});

describe("the stored password", () => {
  it("is never rendered back into the form", () => {
    render(<SmtpPanel value={CONFIGURED} />);

    // The name starts with the label and continues into its hint, which is why
    // the pattern is not anchored at the end.

    expect(
      (screen.getByLabelText(/^lösenord/i) as HTMLInputElement).value,
    ).toBe("");
  });

  it("is kept when the field is left empty", async () => {
    const session = userEvent.setup();
    render(<SmtpPanel value={CONFIGURED} />);

    await save(session);

    await waitFor(() => {
      expect(saveSmtp).toHaveBeenCalled();
    });
    // Absent, not null: null would clear it.
    expect(saveSmtp.mock.calls[0]?.[0]).toMatchObject({
      host: "smtp.example.se",
      password: undefined,
    });
  });

  it("is replaced when a new one is typed", async () => {
    const session = userEvent.setup();
    render(<SmtpPanel value={CONFIGURED} />);

    await session.type(screen.getByLabelText(/^lösenord/i), "hunter2hunter2");
    await save(session);

    await waitFor(() => {
      expect(saveSmtp).toHaveBeenCalledWith(
        expect.objectContaining({ password: "hunter2hunter2" }),
      );
    });
  });

  it("is cleared only when that is asked for explicitly", async () => {
    const session = userEvent.setup();
    render(<SmtpPanel value={CONFIGURED} />);

    await session.click(
      screen.getByLabelText(/ta bort det sparade lösenordet/i),
    );
    await save(session);

    await waitFor(() => {
      expect(saveSmtp).toHaveBeenCalledWith(
        expect.objectContaining({ password: null }),
      );
    });
  });

  it("offers no clear control when there is nothing stored", () => {
    render(<SmtpPanel value={EMPTY} />);

    expect(
      screen.queryByLabelText(/ta bort det sparade lösenordet/i),
    ).toBeNull();
  });
});

describe("the unconfigured state", () => {
  it("says what skipping email costs", () => {
    render(<SmtpPanel value={EMPTY} />);

    // The consequence, not just the state: nobody can be invited at all.
    expect(
      screen.getByText(/inbjudningar och inloggningslänkar/i),
    ).toBeTruthy();
  });

  it("cannot send a test before there is a server to send through", () => {
    render(<SmtpPanel value={EMPTY} />);

    expect(
      screen.getByRole("button", { name: /testmeddelande/i }),
    ).toHaveProperty("disabled", true);
  });
});

describe("the test message", () => {
  it("names the mailbox the server actually sent to", async () => {
    const session = userEvent.setup();
    render(<SmtpPanel value={CONFIGURED} />);

    await session.click(
      screen.getByRole("button", { name: /testmeddelande/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/holger@exempel\.se/)).toBeTruthy();
    });
  });

  it("explains a refusal in its own words", async () => {
    sendSmtpTest.mockResolvedValue({
      ok: false,
      failure: { status: 422, reason: "no-email" },
    });
    const session = userEvent.setup();
    render(<SmtpPanel value={CONFIGURED} />);

    await session.click(
      screen.getByRole("button", { name: /testmeddelande/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/saknar en e-postadress/i)).toBeTruthy();
    });
  });
});

describe("a server that sets up no encrypted connection", () => {
  it("is explained as that, not as a wrong password", async () => {
    sendSmtpTest.mockResolvedValue({
      ok: false,
      failure: { status: 502, reason: "mail-tls-unavailable" },
    });
    const session = userEvent.setup();
    render(<SmtpPanel value={CONFIGURED} />);

    await session.click(
      screen.getByRole("button", { name: /testmeddelande/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(/upprättade ingen krypterad anslutning/i),
      ).toBeTruthy();
    });
    expect(
      screen.queryByText(/kontrollera server, port och lösenord/i),
    ).toBeNull();
  });
});

describe("settings saved before TLS was required", () => {
  const LEGACY: StoredSmtpSettings = {
    ...CONFIGURED,
    secure: false,
    tlsOptional: true,
  };

  it("say the password can go out unencrypted until they are saved again", () => {
    render(<SmtpPanel value={LEGACY} />);

    expect(screen.getByText(/lösenordet skickas okrypterat/i)).toBeTruthy();
  });

  it("keep saying so after a test message went through", async () => {
    const session = userEvent.setup();
    render(<SmtpPanel value={LEGACY} />);

    await session.click(
      screen.getByRole("button", { name: /testmeddelande/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/holger@exempel\.se/)).toBeTruthy();
    });
    expect(screen.getByText(/lösenordet skickas okrypterat/i)).toBeTruthy();
  });

  it("stop saying so once a save has required TLS", async () => {
    saveSmtp.mockResolvedValue({
      ok: true,
      value: { ...LEGACY, tlsOptional: false },
    });
    const session = userEvent.setup();
    render(<SmtpPanel value={LEGACY} />);

    await save(session);

    await waitFor(() => {
      expect(screen.getByText("Sparat")).toBeTruthy();
    });
    expect(screen.queryByText(/lösenordet skickas okrypterat/i)).toBeNull();
  });
});

describe("the default port", () => {
  const portField = () => screen.getByLabelText(/^port$/i) as HTMLInputElement;

  it("is the implicit-TLS port while the connection is encrypted", () => {
    /*
     * The checkbox is nodemailer's `secure` flag, which means implicit TLS: the
     * handshake starts on connect, and that is what servers offer on 465. Port
     * 587 opens in cleartext and upgrades through STARTTLS, so offering it here
     * hands an administrator a pair that cannot connect.
     */
    render(<SmtpPanel value={{ ...EMPTY, secure: true }} />);

    expect(portField().value).toBe("465");
  });

  it("is the submission port when the connection is not encrypted", () => {
    render(<SmtpPanel value={{ ...EMPTY, secure: false }} />);

    expect(portField().value).toBe("587");
  });

  it("follows the checkbox while the port is still a default", async () => {
    const session = userEvent.setup();
    render(<SmtpPanel value={{ ...EMPTY, secure: true }} />);

    await session.click(screen.getByLabelText(/krypterad anslutning/i));

    expect(portField().value).toBe("587");
  });

  it("leaves a port the administrator typed alone", async () => {
    const session = userEvent.setup();
    render(<SmtpPanel value={{ ...EMPTY, secure: true }} />);

    await session.clear(portField());
    await session.type(portField(), "2525");
    await session.click(screen.getByLabelText(/krypterad anslutning/i));

    expect(portField().value).toBe("2525");
  });
});

describe("a successful save", () => {
  it("is confirmed even when only the password changed", async () => {
    /*
     * The settings screen keys this panel on the host and on whether a password
     * is stored, so replacing only the password changes neither key: the panel
     * does not remount, and without its own confirmation the screen would look
     * identical before and after the save.
     */
    const session = userEvent.setup();
    render(<SmtpPanel value={CONFIGURED} />);

    await session.type(screen.getByLabelText(/^lösenord/i), "hunter2hunter2");
    await save(session);

    await waitFor(() => {
      expect(screen.getByText("Sparat")).toBeTruthy();
    });
  });
});

describe("a board member who may only read", () => {
  it("gets the fields disabled and no save button", () => {
    render(<SmtpPanel value={CONFIGURED} editable={false} />);

    expect(screen.getByLabelText(/^server$/i)).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: /^spara$/i })).toBeNull();
  });
});

describe("mail set where the instance runs", () => {
  /*
   * The host answers for delivery and for the sending domain there, and the API
   * refuses a change, so the card states what is set and offers nothing that
   * could not be saved (ADR 0024).
   */
  const ENVIRONMENT: EnvironmentMailSettings = {
    source: "environment",
    host: "api.getpost.se",
    fromAddress: "utskick@delad.example",
    configured: true,
  };

  it("names the host and the sender, and has no form", () => {
    render(<SmtpPanel value={ENVIRONMENT} />);

    expect(
      screen.getByText(
        "E-post skickas av den som driver instansen, via api.getpost.se från utskick@delad.example.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Den ställs in där instansen körs och kan inte ändras här.",
      ),
    ).toBeTruthy();
    // Nothing to type into and nothing to save.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByLabelText(/^lösenord/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /^spara$/i })).toBeNull();
  });

  it("still lets the administrator send a test message", async () => {
    const session = userEvent.setup();
    render(<SmtpPanel value={ENVIRONMENT} />);

    await session.click(
      screen.getByRole("button", { name: /testmeddelande/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/holger@exempel\.se/)).toBeTruthy();
    });
    expect(sendSmtpTest).toHaveBeenCalledTimes(1);
  });

  it("points a failed test at whoever runs the instance, not at the server", async () => {
    // The card shows no server, port or password, so the form's advice to
    // check them would be advice the board cannot follow.
    sendSmtpTest.mockResolvedValue({
      ok: false,
      failure: { status: 502, reason: "unexpected" },
    });
    const session = userEvent.setup();
    render(<SmtpPanel value={ENVIRONMENT} />);

    await session.click(
      screen.getByRole("button", { name: /testmeddelande/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Meddelandet kunde inte skickas. E-posten sköts av den som driver instansen, så kontakta dem.",
        ),
      ).toBeTruthy();
    });
  });

  it("points a server without TLS at whoever runs the instance too", async () => {
    sendSmtpTest.mockResolvedValue({
      ok: false,
      failure: { status: 502, reason: "mail-tls-unavailable" },
    });
    const session = userEvent.setup();
    render(<SmtpPanel value={ENVIRONMENT} />);

    await session.click(
      screen.getByRole("button", { name: /testmeddelande/i }),
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Meddelandet kunde inte skickas eftersom e-postservern inte upprättade någon krypterad anslutning. E-posten sköts av den som driver instansen, så kontakta dem.",
        ),
      ).toBeTruthy();
    });
  });

  it("offers a board member who may only read no test either", () => {
    render(<SmtpPanel value={ENVIRONMENT} editable={false} />);

    expect(
      screen.queryByRole("button", { name: /testmeddelande/i }),
    ).toBeNull();
  });
});

describe("a save the environment refuses", () => {
  it("says the mail is set where the instance runs", async () => {
    // The environment began setting the mail after the screen was loaded.
    saveSmtp.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "mail-managed-by-environment" },
    });
    const session = userEvent.setup();
    render(<SmtpPanel value={CONFIGURED} />);

    await save(session);

    await waitFor(() => {
      expect(
        screen.getByText(
          "E-posten ställs in där instansen körs och kan inte ändras här.",
        ),
      ).toBeTruthy();
    });
  });
});

describe("while the email settings are being saved", () => {
  /** Holds the request open, so the form is observed mid-save. */
  function holdRequest(): (outcome: unknown) => void {
    let settle: (outcome: unknown) => void = () => undefined;
    saveSmtp.mockReturnValue(
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

  it("locks the form, so nothing typed is lost when the password is cleared", async () => {
    const session = userEvent.setup();
    const settle = holdRequest();
    render(<SmtpPanel value={CONFIGURED} />);

    const secret = screen.getByLabelText<HTMLInputElement>(/^lösenord/i);
    const other = screen.getByLabelText<HTMLInputElement>(/^användarnamn/i);
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
    expect(other.value).toBe("styrelsen");

    settle({ ok: true, value: CONFIGURED });

    await waitFor(() => {
      expect(secret.matches(":disabled")).toBe(false);
    });
    expect(secret.value).toBe("");
    expect(other.value).toBe("styrelsen");
  });

  it.each(OUTCOMES)(
    "keeps focus in the password field after Enter, %s",
    async (_case, outcome) => {
      const session = userEvent.setup();
      const settle = holdRequest();
      render(<SmtpPanel value={CONFIGURED} />);

      const secret = screen.getByLabelText<HTMLInputElement>(/^lösenord/i);
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

describe("a save the stored password does not follow", () => {
  // The stored password is not sent to a new host on the strength of an empty
  // field, and the refusal has to say what to do about it. A save that changed
  // nothing about the server and met another save's password is not told that
  // the server changed.
  it.each([
    [
      "the server, port or encryption it changed",
      400,
      "secret-required-for-new-endpoint",
      /^servern, porten eller krypteringen har ändrats\. ange lösenordet igen/i,
    ],
    [
      "a change saved elsewhere meanwhile",
      409,
      "secret-endpoint-changed-during-save",
      /^servern eller det sparade lösenordet ändrades någon annanstans.*ange lösenordet igen/i,
    ],
  ])(
    "names %s and asks for the password again",
    async (_, status, reason, message) => {
      saveSmtp.mockResolvedValue({ ok: false, failure: { status, reason } });
      const session = userEvent.setup();
      render(<SmtpPanel value={CONFIGURED} />);

      await save(session);

      await waitFor(() => {
        expect(screen.getByText(message)).toBeTruthy();
      });
    },
  );
});
