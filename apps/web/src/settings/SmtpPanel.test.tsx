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

describe("a save that moves the server", () => {
  it("asks for the password again rather than a generic failure", async () => {
    // The stored password is not sent to a new host on the strength of an
    // empty field, and the refusal has to say what to do about it.
    saveSmtp.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "secret-required-for-new-endpoint" },
    });
    const session = userEvent.setup();
    render(<SmtpPanel value={CONFIGURED} />);

    await save(session);

    await waitFor(() => {
      expect(screen.getByText(/ange lösenordet igen/i)).toBeTruthy();
    });
  });
});
