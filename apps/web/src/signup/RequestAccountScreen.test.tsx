import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { HONEYPOT_FIELD } from "../ui/HoneypotField";
import { RequestAccountScreen } from "./RequestAccountScreen";

/**
 * The form a visitor with no account meets.
 *
 * Two things are load-bearing and neither is cosmetic. The screen must not
 * offer a form on an instance whose board has the door shut - a submission
 * would be refused, and being turned away by a form you were invited to fill in
 * reads as a fault in the instance rather than as a decision the board made.
 * And what it says after a submission has to be true: a request creates no
 * account and no entry in the register until a board member approves it, and a
 * screen that says "welcome" would be a promise nobody made.
 */

const fetchSignupState = vi.fn();
const submitSignupRequest = vi.fn();

vi.mock("../api/signup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/signup")>()),
  fetchSignupState: () => fetchSignupState(),
  submitSignupRequest: (input: unknown) => submitSignupRequest(input),
}));

const heading = () => screen.getByRole("heading", { name: "Ansök om konto" });

async function fillTheForm(session: ReturnType<typeof userEvent.setup>) {
  await session.type(screen.getByLabelText("Förnamn"), "Elsa");
  await session.type(screen.getByLabelText("Efternamn"), "Norberg");
  await session.type(screen.getByLabelText("E-postadress"), "elsa@exempel.se");
  await session.type(screen.getByLabelText("Adress"), "Storgatan 12");
  await session.type(screen.getByLabelText("Lägenhetsnummer"), "1203");
}

beforeEach(() => {
  fetchSignupState.mockReset().mockResolvedValue({
    ok: true,
    value: { enabled: true },
  });
  submitSignupRequest
    .mockReset()
    .mockResolvedValue({ ok: true, value: { id: "request-1" } });
});

describe("a closed instance", () => {
  it("says so instead of offering the form", async () => {
    fetchSignupState.mockResolvedValue({ ok: true, value: { enabled: false } });

    render(<RequestAccountScreen />);

    await waitFor(() => {
      expect(screen.getByText(/tar inte emot ansökningar/i)).toBeTruthy();
    });
    expect(heading()).toBeTruthy();
    expect(screen.queryByLabelText("Förnamn")).toBeNull();
  });

  it("says so when the instance cannot be asked", async () => {
    // The same treatment as an answered "no". Rendering the form on a guess
    // offers a visitor something the server would refuse anyway.
    fetchSignupState.mockResolvedValue({
      ok: false,
      failure: { status: 0, reason: "offline" },
    });

    render(<RequestAccountScreen />);

    await waitFor(() => {
      expect(screen.getByText(/tar inte emot ansökningar/i)).toBeTruthy();
    });
    expect(screen.queryByLabelText("Förnamn")).toBeNull();
  });
});

describe("an open instance", () => {
  it("sends what was typed, with no phone number when none was given", async () => {
    const session = userEvent.setup();
    render(<RequestAccountScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText("Förnamn")).toBeTruthy();
    });
    await fillTheForm(session);
    await session.click(screen.getByRole("button", { name: "Skicka ansökan" }));

    await waitFor(() => {
      expect(submitSignupRequest).toHaveBeenCalledTimes(1);
    });
    // The key is absent rather than empty: the endpoint encrypts whatever
    // arrives, and "" would be stored as a phone number that is not one.
    expect(submitSignupRequest).toHaveBeenCalledWith({
      firstName: "Elsa",
      lastName: "Norberg",
      email: "elsa@exempel.se",
      claimedAddress: "Storgatan 12",
      claimedApartmentNumber: "1203",
    });
  });

  it("sends the phone number when one was given", async () => {
    const session = userEvent.setup();
    render(<RequestAccountScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText("Förnamn")).toBeTruthy();
    });
    await fillTheForm(session);
    await session.type(
      screen.getByLabelText(/telefonnummer/i),
      "  070-123 45 67  ",
    );
    await session.click(screen.getByRole("button", { name: "Skicka ansökan" }));

    await waitFor(() => {
      expect(submitSignupRequest).toHaveBeenCalledWith(
        expect.objectContaining({ phone: "070-123 45 67" }),
      );
    });
  });

  it("is honest about what a sent request has done", async () => {
    const session = userEvent.setup();
    render(<RequestAccountScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText("Förnamn")).toBeTruthy();
    });
    await fillTheForm(session);
    await session.click(screen.getByRole("button", { name: "Skicka ansökan" }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Ansökan är mottagen" }),
      ).toBeTruthy();
    });
    // Nothing exists yet, and a second request replaces this one rather than
    // queueing twice. Both are facts the applicant can only learn here.
    expect(
      screen.getByText(/varken konto eller post i registret/i),
    ).toBeTruthy();
    expect(screen.getByText(/ersätter den här/i)).toBeTruthy();
    // The form is gone, so nobody sends the same request twice.
    expect(screen.queryByLabelText("Förnamn")).toBeNull();
  });
});

describe("the decoy field", () => {
  it("is not one of the fields a person is asked to fill in", async () => {
    const { container } = render(<RequestAccountScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText("Förnamn")).toBeTruthy();
    });

    // In the page for a script to find, and reachable by nothing that has an
    // accessible name: every field a person meets on this form has one.
    expect(
      container.querySelector(`input[name="${HONEYPOT_FIELD}"]`),
    ).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "" })).toBeNull();
  });

  it("travels with the submission when something filled it in", async () => {
    const session = userEvent.setup();
    const { container } = render(<RequestAccountScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText("Förnamn")).toBeTruthy();
    });
    await fillTheForm(session);

    const decoy = container.querySelector(`input[name="${HONEYPOT_FIELD}"]`);
    if (decoy === null) {
      throw new Error("The decoy field was expected to be rendered.");
    }
    fireEvent.change(decoy, { target: { value: "https://example.invalid" } });
    await session.click(screen.getByRole("button", { name: "Skicka ansökan" }));

    // The endpoint decides what to do about it. This screen only has to send
    // what it was given, which is what lets the server drop the submission
    // while answering as though it had kept it.
    await waitFor(() => {
      expect(submitSignupRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          [HONEYPOT_FIELD]: "https://example.invalid",
        }),
      );
    });
  });
});

describe("a refused submission", () => {
  it("closes the screen when the board switched the form off meanwhile", async () => {
    submitSignupRequest.mockResolvedValue({
      ok: false,
      failure: { status: 403, reason: "self-signup-disabled" },
    });

    const session = userEvent.setup();
    render(<RequestAccountScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText("Förnamn")).toBeTruthy();
    });
    await fillTheForm(session);
    await session.click(screen.getByRole("button", { name: "Skicka ansökan" }));

    await waitFor(() => {
      expect(screen.getByText(/tar inte emot ansökningar/i)).toBeTruthy();
    });
    /*
     * Not "your account is not allowed": the shared 403 sentence is about the
     * viewer's account, and this visitor has none. The door was shut between
     * the load and the submission, which is what the closed notice says.
     */
    expect(screen.queryByText(/ditt konto får inte/i)).toBeNull();
    expect(screen.queryByLabelText("Förnamn")).toBeNull();
  });

  it("names a rejected email address without closing the form", async () => {
    submitSignupRequest.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "invalid-email" },
    });

    const session = userEvent.setup();
    render(<RequestAccountScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText("Förnamn")).toBeTruthy();
    });
    await fillTheForm(session);
    await session.click(screen.getByRole("button", { name: "Skicka ansökan" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "Kontrollera e-postadressen",
      );
    });
    // Retryable, so what was typed stays on the screen.
    expect(screen.getByLabelText("Förnamn")).toHaveProperty("value", "Elsa");
  });

  it("falls back to one sentence for anything else", async () => {
    submitSignupRequest.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    const session = userEvent.setup();
    render(<RequestAccountScreen />);

    await waitFor(() => {
      expect(screen.getByLabelText("Förnamn")).toBeTruthy();
    });
    await fillTheForm(session);
    await session.click(screen.getByRole("button", { name: "Skicka ansökan" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "kunde inte skickas just nu",
      );
    });
  });
});
