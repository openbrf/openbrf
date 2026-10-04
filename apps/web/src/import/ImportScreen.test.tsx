import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { ImportScreen } from "./ImportScreen";
import type {
  ImportPreview,
  ImportPreviewRun,
  ImportRunView,
  ImportSessionView,
} from "./import-api";

/**
 * The router's Link needs a router context this screen's tests have no use for,
 * so it is replaced with an anchor. What is under test here is the import, not
 * routing.
 */
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    className,
  }: {
    to: string;
    children: ReactNode;
    className?: string;
  }): ReactElement => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

/**
 * The import, from a file to a written register.
 *
 * What is pinned here is the part that protects the register rather than the
 * part that fills it: a row matching two people blocks the whole import until
 * somebody chooses, and the personal identity number a file carries is reported
 * as present and never shown - a preview is not a register view.
 *
 * And the part that follows the register write, which happens in a job the
 * screen does not control: it shows how far the import has got, it finds an
 * import again when the screen is opened with nothing in its hands, and it says
 * plainly when one stopped rather than dressing it up as a result.
 */

const IDENTITY_NUMBER = "19811228-9874";

const uploadImport = vi.fn();
const previewImport = vi.fn();
const fetchImportPreview = vi.fn();
const cancelImportPreview = vi.fn();
const applyImport = vi.fn();
const fetchImportRun = vi.fn();
const fetchActiveImport = vi.fn();

vi.mock("./import-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./import-api")>()),
  uploadImport: (input: unknown) => uploadImport(input),
  previewImport: (sessionId: string, input: unknown) =>
    previewImport(sessionId, input),
  fetchImportPreview: (
    sessionId: string,
    previewId: string,
    signal?: AbortSignal,
    answerTimeoutMs?: number,
  ) => fetchImportPreview(sessionId, previewId, signal, answerTimeoutMs),
  cancelImportPreview: (sessionId: string, previewId: string) =>
    cancelImportPreview(sessionId, previewId),
  applyImport: (sessionId: string, input: unknown) =>
    applyImport(sessionId, input),
  fetchImportRun: (sessionId: string) => fetchImportRun(sessionId),
  fetchActiveImport: () => fetchActiveImport(),
}));

/**
 * The uploaded file carries a personal identity number, because a real member
 * list does.
 *
 * The session stays in the screen's state for the whole flow, which is what
 * gives the privacy assertion below something to catch: the number is a value
 * the component is holding when the preview renders, and the preview has to
 * report it as present without putting it on the page.
 */
const SESSION: ImportSessionView = {
  sessionId: "session-1",
  fileName: "medlemmar.csv",
  format: "CSV",
  columns: ["Lgh", "Namn", "E-post", "Personnummer"],
  rowCount: 3,
  sample: [["1103", "Anna Lindqvist", "anna@exempel.se", IDENTITY_NUMBER]],
  suggestedMapping: [
    "apartmentNumber",
    "fullName",
    "email",
    "personalIdentityNumber",
  ],
  expiresAt: "2026-08-29T00:00:00.000Z",
};

const PREVIEW: ImportPreview = {
  sessionId: "session-1",
  previewToken: "preview-1",
  summary: { create: 1, update: 1, ambiguous: 1, error: 1 },
  rows: [
    {
      rowNumber: 1,
      outcome: "create",
      person: {
        firstName: "Anna",
        lastName: "Lindqvist",
        email: "anna@exempel.se",
        phone: null,
        hasPersonalIdentityNumber: true,
        postalStreet: null,
        postalCode: null,
        postalCity: null,
      },
      apartment: {
        id: "apartment-1103",
        number: "1103",
        addressLabel: "Storgatan 12",
      },
      role: "MEMBER",
      movedInOn: "2019-06-01",
      movedOutOn: null,
      matchedPersonId: null,
      matchedPersonName: null,
      matchedBy: null,
      mismatch: null,
      sameAsRowNumber: null,
      candidates: [],
      problems: [],
    },
    {
      rowNumber: 2,
      outcome: "ambiguous",
      person: {
        firstName: "Bo",
        lastName: "Berg",
        email: null,
        phone: null,
        hasPersonalIdentityNumber: false,
        postalStreet: null,
        postalCode: null,
        postalCity: null,
      },
      apartment: {
        id: "apartment-1201",
        number: "1201",
        addressLabel: "Storgatan 12",
      },
      role: "RESIDENT",
      movedInOn: "2020-01-01",
      movedOutOn: null,
      matchedPersonId: null,
      matchedPersonName: null,
      matchedBy: "apartmentAndName",
      mismatch: null,
      sameAsRowNumber: null,
      candidates: [
        { personId: "person-bo-senior", name: "Bo Berg" },
        { personId: "person-bo-junior", name: "Bo Berg" },
      ],
      problems: [],
    },
    {
      rowNumber: 3,
      outcome: "error",
      person: {
        firstName: "Cia",
        lastName: "Ek",
        email: null,
        phone: null,
        hasPersonalIdentityNumber: false,
        postalStreet: null,
        postalCode: null,
        postalCity: null,
      },
      apartment: null,
      role: "MEMBER",
      movedInOn: null,
      movedOutOn: null,
      matchedPersonId: null,
      matchedPersonName: null,
      matchedBy: null,
      mismatch: null,
      sameAsRowNumber: null,
      candidates: [],
      problems: [{ field: "movedInOn", reason: "date-not-iso" }],
    },
    {
      rowNumber: 4,
      outcome: "update",
      person: {
        firstName: "Dag",
        lastName: "Dahl",
        email: "dag@exempel.se",
        phone: null,
        hasPersonalIdentityNumber: false,
        postalStreet: null,
        postalCode: null,
        postalCity: null,
      },
      apartment: {
        id: "apartment-1202",
        number: "1202",
        addressLabel: "Storgatan 12",
      },
      role: "RESIDENT",
      movedInOn: "2020-01-01",
      movedOutOn: null,
      matchedPersonId: "person-dag",
      matchedPersonName: "Dag Dahlström",
      matchedBy: "email",
      mismatch: null,
      sameAsRowNumber: null,
      candidates: [],
      problems: [],
    },
  ],
};

/** The preview as the API reports it while it is planned, and once it is. */
function previewRun(
  overrides: Partial<ImportPreviewRun> = {},
): ImportPreviewRun {
  return {
    sessionId: "session-1",
    previewId: "planning-1",
    status: "READY",
    rowsDone: 3,
    rowsTotal: 3,
    failureReason: null,
    preview: PREVIEW,
    ...overrides,
  };
}

const PLANNING = previewRun({ status: "PLANNING", rowsDone: 0, preview: null });

/** How often the screen asks after a preview being planned. */
const PREVIEW_POLL_MS = 1500;

/** How long the screen waits for a poll before it gives it up. */
const PREVIEW_POLL_TIMEOUT_MS = 4 * PREVIEW_POLL_MS;

/** The import as the API reports it back while, and after, it runs. */
function runView(overrides: Partial<ImportRunView> = {}): ImportRunView {
  return {
    sessionId: "session-1",
    fileName: "medlemmar.csv",
    status: "QUEUED",
    rowsDone: 0,
    rowsTotal: 3,
    result: {
      personsCreated: 0,
      personsUpdated: 0,
      residenciesCreated: 0,
      memberRegisterEntriesCreated: 0,
      skipped: 0,
      errors: 0,
    },
    failureReason: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

/** A CSV small enough to build in the test, uploaded through the file input. */
function file(): File {
  return new File(
    ["Lgh;Namn;E-post\n1103;Anna Lindqvist;anna@exempel.se\n"],
    "medlemmar.csv",
    { type: "text/csv" },
  );
}

async function reachPreview(session: ReturnType<typeof userEvent.setup>) {
  render(<ImportScreen />);

  await session.upload(screen.getByLabelText(/Välj en fil/), file());
  await session.click(screen.getByRole("button", { name: /Läs filen/ }));
  await screen.findByText(/Kolumnerna/);

  // The fixture file has no move-in column, so the screen requires a date for
  // the whole file before it will preview anything.
  fireEvent.change(screen.getByLabelText(/^Inflyttningsdatum/), {
    target: { value: "2019-06-01" },
  });

  await session.click(
    screen.getByRole("button", { name: /Förhandsgranska importen/ }),
  );
  await screen.findByText(/Vad detta skulle göra/);
}

/** Up to the mapping step, with the date the fixture file needs filled in. */
async function reachMapping(session: ReturnType<typeof userEvent.setup>) {
  render(<ImportScreen />);

  await session.upload(screen.getByLabelText(/Välj en fil/), file());
  await session.click(screen.getByRole("button", { name: /Läs filen/ }));
  await screen.findByText(/Kolumnerna/);
  fireEvent.change(screen.getByLabelText(/^Inflyttningsdatum/), {
    target: { value: "2019-06-01" },
  });
}

const FINISHED = runView({
  status: "APPLIED",
  rowsDone: 3,
  finishedAt: "2026-08-28T09:00:00.000Z",
  result: {
    personsCreated: 1,
    personsUpdated: 1,
    residenciesCreated: 2,
    memberRegisterEntriesCreated: 1,
    skipped: 0,
    errors: 1,
  },
});

beforeEach(() => {
  uploadImport.mockReset().mockResolvedValue({ ok: true, value: SESSION });
  // Ready at once, so a case about the preview step does not wait out a poll
  // to reach it. The API answers a request with a preview still planning,
  // and the wait is pinned in its own cases below.
  previewImport.mockReset().mockResolvedValue({
    ok: true,
    value: previewRun(),
  });
  fetchImportPreview.mockReset().mockResolvedValue({
    ok: true,
    value: previewRun(),
  });
  cancelImportPreview
    .mockReset()
    .mockResolvedValue({ ok: true, value: undefined });
  // The apply is accepted, not done: what comes back is a queued import.
  applyImport.mockReset().mockResolvedValue({ ok: true, value: runView() });
  fetchImportRun.mockReset().mockResolvedValue({ ok: true, value: FINISHED });
  fetchActiveImport.mockReset().mockResolvedValue({ ok: true, value: null });
});

describe("the mapping step", () => {
  it("shows the guess the column titles produced", async () => {
    const session = userEvent.setup();
    render(<ImportScreen />);

    await session.upload(screen.getByLabelText(/Välj en fil/), file());
    await session.click(screen.getByRole("button", { name: /Läs filen/ }));

    await screen.findByText(/Kolumnerna/);
    const selects = screen.getAllByRole("combobox");
    expect((selects[0] as HTMLSelectElement).value).toBe("apartmentNumber");
    expect((selects[1] as HTMLSelectElement).value).toBe("fullName");
    expect((selects[2] as HTMLSelectElement).value).toBe("email");
  });

  it("names each column in the accessible name of its own select", async () => {
    // One name shared by every combobox leaves a screen-reader user with no
    // way to tell which column they are on, and a column sent to the wrong
    // field writes a register entry that cannot be corrected by editing.
    const session = userEvent.setup();
    render(<ImportScreen />);

    await session.upload(screen.getByLabelText(/Välj en fil/), file());
    await session.click(screen.getByRole("button", { name: /Läs filen/ }));
    await screen.findByText(/Kolumnerna/);

    for (const column of SESSION.columns) {
      expect(
        screen.getByRole("combobox", {
          name: new RegExp(`Fält i registret för ${column}`),
        }),
      ).toBeTruthy();
    }
  });

  it("asks for a role for the whole file when no column carries one", async () => {
    // Nothing may guess this: a row read as "member" writes an entry in a
    // register that cannot be deleted.
    const session = userEvent.setup();
    render(<ImportScreen />);

    await session.upload(screen.getByLabelText(/Välj en fil/), file());
    await session.click(screen.getByRole("button", { name: /Läs filen/ }));

    expect(await screen.findByLabelText(/^Roll/)).toBeTruthy();
  });
});

describe("while the preview is planned", () => {
  // Only the screen's poll is faked, so each poll happens when a test moves the
  // clock rather than when a loaded machine gets round to it. Everything else -
  // the user events, the waits for the screen to settle - runs on real time.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets the screen ask once, as it does every poll interval. */
  async function nextPoll(): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS);
    });
  }

  it("keeps the preview on screen while it is taken again with the decisions", async () => {
    // The apply found that the decisions change what other rows match. The
    // preview they produce is planned by the job like any other, and until it
    // is ready the board sees the one it was looking at and cannot apply it.
    const session = userEvent.setup();
    await reachPreview(session);

    applyImport.mockResolvedValueOnce({
      ok: false,
      failure: { status: 400, reason: "preview-outdated" },
    });
    previewImport.mockResolvedValue({ ok: true, value: PLANNING });
    fetchImportPreview
      .mockResolvedValueOnce({
        ok: true,
        value: previewRun({ status: "PLANNING", rowsDone: 2, preview: null }),
      })
      .mockResolvedValue({ ok: true, value: previewRun() });

    await session.selectOptions(
      screen.getByRole("combobox", { name: /Den här raden är/ }),
      "person-bo-senior",
    );
    await session.click(
      screen.getByRole("button", { name: /Genomför importen/ }),
    );

    expect(await screen.findByText(/2 av 3 rader/)).toBeTruthy();
    expect(screen.getByText(/Vad detta skulle göra/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /Genomför importen/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(previewImport).toHaveBeenLastCalledWith(
      "session-1",
      expect.objectContaining({
        decisions: {
          "2": { action: "use-person", personId: "person-bo-senior" },
        },
      }),
    );

    await nextPoll();

    expect(
      await screen.findByText(/förhandsgranskningen har gjorts om/),
    ).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(
      (
        screen.getByRole("combobox", {
          name: /Den här raden är/,
        }) as HTMLSelectElement
      ).value,
    ).toBe("person-bo-senior");
    expect(
      screen
        .getByRole("button", { name: /Genomför importen/ })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("shows how far it has got, and the preview once it is ready", async () => {
    const session = userEvent.setup();
    previewImport.mockResolvedValue({ ok: true, value: PLANNING });
    fetchImportPreview
      .mockResolvedValueOnce({
        ok: true,
        value: previewRun({ status: "PLANNING", rowsDone: 2, preview: null }),
      })
      .mockResolvedValue({ ok: true, value: previewRun() });

    await reachMapping(session);
    await session.click(
      screen.getByRole("button", { name: /Förhandsgranska importen/ }),
    );

    // Accepted, not done: the screen stays on the mapping and says so. It
    // asks once straight away rather than waiting out the first interval.
    expect(
      await screen.findByRole("progressbar", {
        name: /Hur stor del av filen som gåtts igenom/,
      }),
    ).toBeTruthy();
    expect(await screen.findByText(/2 av 3 rader/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /Räknar ut vad som skulle hända/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    // The mapping being planned is the one on the screen until it is ready.
    expect(
      screen
        .getByRole("combobox", { name: /Personnummer/ })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(fetchImportPreview).toHaveBeenCalledTimes(1);

    // Then on its own, once every poll interval.
    await nextPoll();
    expect(await screen.findByText(/Vad detta skulle göra/)).toBeTruthy();
    expect(fetchImportPreview).toHaveBeenCalledTimes(2);
    expect(fetchImportPreview).toHaveBeenCalledWith(
      "session-1",
      "planning-1",
      expect.any(AbortSignal),
      PREVIEW_POLL_TIMEOUT_MS,
    );
    // A preview that finished has nothing to cancel.
    expect(cancelImportPreview).not.toHaveBeenCalled();
  });

  it("shows a short file's preview without waiting a poll interval", async () => {
    const session = userEvent.setup();
    previewImport.mockResolvedValue({ ok: true, value: PLANNING });

    await reachMapping(session);
    await session.click(
      screen.getByRole("button", { name: /Förhandsgranska importen/ }),
    );

    expect(await screen.findByText(/Vad detta skulle göra/)).toBeTruthy();
    expect(fetchImportPreview).toHaveBeenCalledTimes(1);
  });

  it("cancels the preview when the board picks another file", async () => {
    // Otherwise the job goes on planning it, and every other preview on the
    // instance waits behind it until the API notices nobody is asking.
    const session = userEvent.setup();
    previewImport.mockResolvedValue({ ok: true, value: PLANNING });
    fetchImportPreview.mockResolvedValue({ ok: true, value: PLANNING });

    await reachMapping(session);
    await session.click(
      screen.getByRole("button", { name: /Förhandsgranska importen/ }),
    );
    await screen.findByRole("progressbar");
    await session.click(
      screen.getByRole("button", { name: /Välj en annan fil/ }),
    );

    expect(cancelImportPreview).toHaveBeenCalledTimes(1);
    expect(cancelImportPreview).toHaveBeenCalledWith("session-1", "planning-1");
    // And stops asking about it.
    const asked = fetchImportPreview.mock.calls.length;
    await nextPoll();
    expect(fetchImportPreview).toHaveBeenCalledTimes(asked);
  });

  it("gives up the poll in flight when the board stops waiting", async () => {
    // A stalled request would otherwise live on until its own timeout.
    const session = userEvent.setup();
    previewImport.mockResolvedValue({ ok: true, value: PLANNING });
    fetchImportPreview.mockResolvedValue({ ok: true, value: PLANNING });

    await reachMapping(session);
    await session.click(
      screen.getByRole("button", { name: /Förhandsgranska importen/ }),
    );
    await screen.findByRole("progressbar");
    const signal = fetchImportPreview.mock.calls[0]?.[2] as AbortSignal;
    expect(signal.aborted).toBe(false);

    await session.click(
      screen.getByRole("button", { name: /Välj en annan fil/ }),
    );

    expect(signal.aborted).toBe(true);
  });

  it("cancels a preview that is answered after the board stepped back", async () => {
    // The request is still pending when Back is pressed; the answer starts a
    // preview nobody waits for, and must neither poll on the upload step nor
    // move the screen to the preview when it is ready.
    const session = userEvent.setup();
    let answer: (value: unknown) => void = () => undefined;
    previewImport.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    fetchImportPreview.mockResolvedValue({ ok: true, value: previewRun() });

    await reachMapping(session);
    await session.click(
      screen.getByRole("button", { name: /Förhandsgranska importen/ }),
    );
    await session.click(
      screen.getByRole("button", { name: /Välj en annan fil/ }),
    );
    expect(cancelImportPreview).not.toHaveBeenCalled();

    await act(async () => {
      answer({ ok: true, value: PLANNING });
      await Promise.resolve();
    });
    await nextPoll();

    expect(cancelImportPreview).toHaveBeenCalledTimes(1);
    expect(cancelImportPreview).toHaveBeenCalledWith("session-1", "planning-1");
    expect(fetchImportPreview).not.toHaveBeenCalled();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/Anna Lindqvist/)).toBeNull();
  });

  it("cancels the preview when the page is left", async () => {
    const session = userEvent.setup();
    previewImport.mockResolvedValue({ ok: true, value: PLANNING });
    fetchImportPreview.mockResolvedValue({ ok: true, value: PLANNING });

    await reachMapping(session);
    await session.click(
      screen.getByRole("button", { name: /Förhandsgranska importen/ }),
    );
    await screen.findByRole("progressbar");
    cleanup();

    expect(cancelImportPreview).toHaveBeenCalledWith("session-1", "planning-1");
  });

  it("says the preview stopped, and lets the board ask again", async () => {
    const session = userEvent.setup();
    previewImport.mockResolvedValue({ ok: true, value: PLANNING });
    fetchImportPreview.mockResolvedValue({
      ok: true,
      value: previewRun({
        status: "FAILED",
        rowsDone: 1,
        failureReason: "preview-interrupted",
        preview: null,
      }),
    });

    await reachMapping(session);
    await session.click(
      screen.getByRole("button", { name: /Förhandsgranska importen/ }),
    );
    await nextPoll();

    expect(
      await screen.findByText(/Förhandsgranskningen stoppades/),
    ).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: /Förhandsgranska importen/ })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("stops waiting when somebody else has previewed the upload since", async () => {
    const session = userEvent.setup();
    previewImport.mockResolvedValue({ ok: true, value: PLANNING });
    fetchImportPreview.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "preview-replaced" },
    });

    await reachMapping(session);
    await session.click(
      screen.getByRole("button", { name: /Förhandsgranska importen/ }),
    );

    // The poll straight after the preview was accepted is refused.
    expect(
      await screen.findByText(/förhandsgranskat uppladdningen igen/),
    ).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/Vad detta skulle göra/)).toBeNull();
    expect(fetchImportPreview).toHaveBeenCalledTimes(1);

    // And stops asking.
    await nextPoll();
    expect(fetchImportPreview).toHaveBeenCalledTimes(1);
  });

  it("does not ask again while the last poll is unanswered", async () => {
    const session = userEvent.setup();
    previewImport.mockResolvedValue({ ok: true, value: PLANNING });
    let answer: (value: unknown) => void = () => undefined;
    fetchImportPreview
      .mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        }),
      )
      .mockResolvedValue({ ok: true, value: previewRun() });

    await reachMapping(session);
    await session.click(
      screen.getByRole("button", { name: /Förhandsgranska importen/ }),
    );
    await waitFor(() => {
      expect(fetchImportPreview).toHaveBeenCalledTimes(1);
    });
    await nextPoll();
    expect(fetchImportPreview).toHaveBeenCalledTimes(1);

    // Once it is answered, the next interval asks again.
    await act(async () => {
      answer({ ok: true, value: PLANNING });
    });
    await nextPoll();
    expect(await screen.findByText(/Vad detta skulle göra/)).toBeTruthy();
    expect(fetchImportPreview).toHaveBeenCalledTimes(2);
  });

  it("gives up a poll that is never answered and asks again", async () => {
    const session = userEvent.setup();
    previewImport.mockResolvedValue({ ok: true, value: PLANNING });
    // The first poll hangs until the client's answer timeout gives it up: it
    // then comes back the way a request that never got an answer does.
    fetchImportPreview
      .mockImplementationOnce(
        (
          _sessionId: string,
          _previewId: string,
          _signal?: AbortSignal,
          answerTimeoutMs?: number,
        ) =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve({ ok: false, failure: { status: 0, reason: "offline" } });
            }, answerTimeoutMs);
          }),
      )
      .mockResolvedValue({ ok: true, value: previewRun() });

    await reachMapping(session);

    // The timeout is a timer too, and the user events and waits of the steps
    // above need the real one, so it is faked only from here: the click is sent
    // without them and the clock is moved by hand.
    vi.useRealTimers();
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /Förhandsgranska importen/ }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchImportPreview).toHaveBeenCalledTimes(1);

    // Held unanswered for less than the timeout, nothing more is sent.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_POLL_TIMEOUT_MS - 1);
    });
    expect(fetchImportPreview).toHaveBeenCalledTimes(1);

    // Past it, the poll is given up and the next tick sends a new one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_POLL_MS + 1);
    });
    expect(screen.getByText(/Vad detta skulle göra/)).toBeTruthy();
    expect(fetchImportPreview).toHaveBeenCalledTimes(2);
  });

  it("goes on waiting through a request that never reached the server", async () => {
    const session = userEvent.setup();
    previewImport.mockResolvedValue({ ok: true, value: PLANNING });
    fetchImportPreview
      .mockResolvedValueOnce({
        ok: false,
        failure: { status: 0, reason: "offline" },
      })
      .mockResolvedValue({ ok: true, value: previewRun() });

    await reachMapping(session);
    await session.click(
      screen.getByRole("button", { name: /Förhandsgranska importen/ }),
    );
    await waitFor(() => {
      expect(fetchImportPreview).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole("progressbar")).toBeTruthy();
    await nextPoll();

    expect(await screen.findByText(/Vad detta skulle göra/)).toBeTruthy();
  });
});

describe("the preview", () => {
  it("counts what would happen without anything happening", async () => {
    const session = userEvent.setup();
    await reachPreview(session);

    expect(screen.getByText(/Ingenting är skrivet ännu/)).toBeTruthy();
    expect(applyImport).not.toHaveBeenCalled();
  });

  it("reports a personal identity number in the file without showing it", async () => {
    const session = userEvent.setup();
    await reachPreview(session);

    expect(screen.getByText(/innehåller ett personnummer/i)).toBeTruthy();
    expect(screen.queryByText(IDENTITY_NUMBER)).toBeNull();
    // Not only that one value: nothing shaped like a personal identity number
    // belongs on this screen. A preview is not a register view, and the file's
    // own numbers are in the session the screen is holding while it renders.
    expect(document.body.textContent).not.toMatch(/\d{6,8}[-+]\d{4}/);
  });

  it("names the person a row was matched to", async () => {
    // The board approves what is written to whom, so the person has to be on
    // the screen and not only an identifier the board cannot read.
    const session = userEvent.setup();
    await reachPreview(session);

    expect(screen.getByText("Matchad person: Dag Dahlström")).toBeTruthy();
  });

  it("says a row's identity number is not added to a person it matched on something else", async () => {
    const [created, , , updated] = PREVIEW.rows;
    if (created === undefined || updated === undefined) {
      throw new Error("The fixture preview has changed shape.");
    }
    previewImport.mockResolvedValue({
      ok: true,
      value: previewRun({
        preview: {
          ...PREVIEW,
          summary: { create: 1, update: 1, ambiguous: 0, error: 0 },
          rows: [
            created,
            {
              ...updated,
              person: { ...updated.person, hasPersonalIdentityNumber: true },
            },
          ],
        },
      }),
    });
    const session = userEvent.setup();
    await reachPreview(session);

    expect(
      screen.getByText(/Personnumret läggs inte till på den här personen/),
    ).toBeTruthy();
  });

  it("says why a row that matched one person still waits for a decision", async () => {
    const [created, , , updated] = PREVIEW.rows;
    if (created === undefined || updated === undefined) {
      throw new Error("The fixture preview has changed shape.");
    }
    previewImport.mockResolvedValue({
      ok: true,
      value: previewRun({
        preview: {
          ...PREVIEW,
          summary: { create: 1, update: 0, ambiguous: 1, error: 0 },
          rows: [
            created,
            {
              ...updated,
              outcome: "ambiguous",
              matchedPersonId: null,
              matchedPersonName: null,
              mismatch: "personalIdentityNumber",
              candidates: [{ personId: "person-dag", name: "Dag Dahlström" }],
            },
          ],
        },
      }),
    });
    const session = userEvent.setup();
    await reachPreview(session);

    expect(
      screen.getByText(
        /Filens personnummer skiljer sig från den här personens/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: "Dag Dahlström" })).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /Genomför importen/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("says a row's identity number is not added to the person chosen for it", async () => {
    // Matched by email and waiting because the name differs: choosing the
    // person writes the row to them, but not its identity number.
    const [created, , , updated] = PREVIEW.rows;
    if (created === undefined || updated === undefined) {
      throw new Error("The fixture preview has changed shape.");
    }
    previewImport.mockResolvedValue({
      ok: true,
      value: previewRun({
        preview: {
          ...PREVIEW,
          summary: { create: 1, update: 0, ambiguous: 1, error: 0 },
          rows: [
            created,
            {
              ...updated,
              outcome: "ambiguous",
              person: { ...updated.person, hasPersonalIdentityNumber: true },
              matchedPersonId: null,
              matchedPersonName: null,
              mismatch: "name",
              candidates: [{ personId: "person-dag", name: "Dag Dahlström" }],
            },
          ],
        },
      }),
    });
    const session = userEvent.setup();
    await reachPreview(session);

    const notAdded = /Personnumret läggs inte till på den här personen/;
    expect(screen.queryByText(notAdded)).toBeNull();

    await session.selectOptions(
      screen.getByRole("combobox", { name: /Den här raden är/ }),
      "person-dag",
    );

    expect(screen.getByText(notAdded)).toBeTruthy();
  });

  it("names what is wrong with a row rather than dropping it", async () => {
    const session = userEvent.setup();
    await reachPreview(session);

    expect(screen.getByText(/ÅÅÅÅ-MM-DD/)).toBeTruthy();
  });

  it("flags a name that already lost a letter before anything is written", async () => {
    // The API refuses such a row; what the board has to see is why, next to
    // the name it would otherwise have taken for a display glitch.
    const garbled = PREVIEW.rows[2]!;
    previewImport.mockResolvedValue({
      ok: true,
      value: previewRun({
        preview: {
          ...PREVIEW,
          rows: [
            {
              ...garbled,
              person: { ...garbled.person, firstName: "Bj\uFFFDrk" },
              problems: [{ field: "firstName", reason: "garbled-characters" }],
            },
          ],
        },
      }),
    });
    const session = userEvent.setup();
    await reachPreview(session);

    const row = screen.getByText(/Bj\uFFFDrk/).closest("tr");
    expect(row?.textContent).toMatch(/Ett tecken har redan gått förlorat/);
    expect(row?.textContent).toMatch(/Importeras inte/);
  });

  it("refuses to apply while a row matches more than one person", async () => {
    const session = userEvent.setup();
    await reachPreview(session);

    const apply = screen.getByRole("button", { name: /Genomför importen/ });
    expect(apply.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/matchar fler än en person/)).toBeTruthy();
  });

  it("applies once the ambiguity has been decided, carrying the decision", async () => {
    const session = userEvent.setup();
    await reachPreview(session);

    await session.selectOptions(
      screen.getByRole("combobox", { name: /Den här raden är/ }),
      "person-bo-senior",
    );
    await session.click(
      screen.getByRole("button", { name: /Genomför importen/ }),
    );

    await waitFor(() => {
      expect(applyImport).toHaveBeenCalledWith(
        "session-1",
        expect.objectContaining({
          previewToken: "preview-1",
          decisions: {
            "2": { action: "use-person", personId: "person-bo-senior" },
          },
        }),
      );
    });
  });
});

describe("after pressing apply", () => {
  async function apply(): Promise<void> {
    const session = userEvent.setup();
    await reachPreview(session);

    await session.selectOptions(
      screen.getByRole("combobox", { name: /Den här raden är/ }),
      "skip",
    );
    await session.click(
      screen.getByRole("button", { name: /Genomför importen/ }),
    );
  }

  it("shows the import running rather than a result it does not have", async () => {
    // The register write happens in a job, so there is nothing to report yet.
    // Claiming otherwise would tell a board the import was done before a single
    // row had been written.
    await apply();

    expect(await screen.findByText(/Importen pågår/)).toBeTruthy();
    expect(screen.getByText(/Väntar på att starta/)).toBeTruthy();
    expect(screen.getByText(/0 av 3 rader/)).toBeTruthy();
    expect(screen.getByText(/går inte att ändra eller ta bort/)).toBeTruthy();
  });

  it("shows the import somebody else started rather than a dead end", async () => {
    // Two board members, or two tabs. The one that lost the race is told, and
    // then shown the import that is actually running.
    const session = userEvent.setup();
    await reachPreview(session);

    applyImport.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "session-already-applied" },
    });
    fetchActiveImport.mockResolvedValue({
      ok: true,
      value: runView({ status: "APPLYING", rowsDone: 1 }),
    });

    await session.selectOptions(
      screen.getByRole("combobox", { name: /Den här raden är/ }),
      "skip",
    );
    await session.click(
      screen.getByRole("button", { name: /Genomför importen/ }),
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/redan startad/)).toBeTruthy();
    expect(await screen.findByText(/Skriver registret/)).toBeTruthy();
  });

  it("sends the board back to the mapping when the upload was previewed again", async () => {
    // Another tab, or another board member, previewed the same upload. The
    // decisions on this screen belong to a preview that no longer stands.
    const session = userEvent.setup();
    await reachPreview(session);

    applyImport.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "preview-replaced" },
    });

    await session.selectOptions(
      screen.getByRole("combobox", { name: /Den här raden är/ }),
      "skip",
    );
    await session.click(
      screen.getByRole("button", { name: /Genomför importen/ }),
    );

    expect(
      await screen.findByText(/förhandsgranskat uppladdningen igen/),
    ).toBeTruthy();
    expect(screen.getByText(/Kolumnerna/)).toBeTruthy();
    expect(screen.queryByText(/Vad detta skulle göra/)).toBeNull();
  });

  it("previews again when the decisions make another row need one", async () => {
    // Bo senior gets row 2's details, and row 4 turns out to contradict him.
    // The API refuses before writing anything, and the board is shown the
    // preview the decision produces rather than a refusal it cannot act on.
    const [created, ambiguous, failed, updated] = PREVIEW.rows;
    if (
      created === undefined ||
      ambiguous === undefined ||
      failed === undefined ||
      updated === undefined
    ) {
      throw new Error("The fixture preview has changed shape.");
    }
    const session = userEvent.setup();
    await reachPreview(session);

    applyImport.mockResolvedValueOnce({
      ok: false,
      failure: { status: 400, reason: "ambiguous-rows-undecided" },
    });
    previewImport.mockResolvedValue({
      ok: true,
      value: previewRun({
        preview: {
          ...PREVIEW,
          summary: { create: 1, update: 0, ambiguous: 2, error: 1 },
          rows: [
            created,
            ambiguous,
            failed,
            {
              ...updated,
              outcome: "ambiguous",
              matchedPersonId: null,
              matchedPersonName: null,
              mismatch: "name",
              candidates: [{ personId: "person-bo-senior", name: "Bo Berg" }],
            },
          ],
        },
      }),
    });

    await session.selectOptions(
      screen.getByRole("combobox", { name: /Den här raden är/ }),
      "person-bo-senior",
    );
    await session.click(
      screen.getByRole("button", { name: /Genomför importen/ }),
    );

    expect(
      await screen.findByText(/förhandsgranskningen har gjorts om/),
    ).toBeTruthy();
    expect(previewImport).toHaveBeenLastCalledWith(
      "session-1",
      expect.objectContaining({
        decisions: {
          "2": { action: "use-person", personId: "person-bo-senior" },
        },
      }),
    );
    const choices = screen.getAllByRole("combobox", {
      name: /Den här raden är/,
    });
    expect((choices[0] as HTMLSelectElement).value).toBe("person-bo-senior");
    expect((choices[1] as HTMLSelectElement).value).toBe("");
    expect(
      screen
        .getByRole("button", { name: /Genomför importen/ })
        .hasAttribute("disabled"),
    ).toBe(true);

    await session.selectOptions(choices[1] as HTMLSelectElement, "create");
    await session.click(
      screen.getByRole("button", { name: /Genomför importen/ }),
    );

    await waitFor(() => {
      expect(applyImport).toHaveBeenLastCalledWith("session-1", {
        previewToken: "preview-1",
        decisions: {
          "2": { action: "use-person", personId: "person-bo-senior" },
          "4": { action: "create" },
        },
      });
    });
    expect(await screen.findByText(/Importen pågår/)).toBeTruthy();
  });

  it("drops a chosen person the row no longer matches", async () => {
    // The register changed after the preview, and row 2 now matches other
    // people. Keeping Bo senior would send an answer the row no longer offers,
    // and the apply would refuse it again with nothing for the board to change.
    const [created, ambiguous, failed, updated] = PREVIEW.rows;
    if (
      created === undefined ||
      ambiguous === undefined ||
      failed === undefined ||
      updated === undefined
    ) {
      throw new Error("The fixture preview has changed shape.");
    }
    const session = userEvent.setup();
    await reachPreview(session);

    applyImport.mockResolvedValueOnce({
      ok: false,
      failure: { status: 400, reason: "decision-not-a-candidate" },
    });
    previewImport.mockResolvedValue({
      ok: true,
      value: previewRun({
        preview: {
          ...PREVIEW,
          rows: [
            created,
            {
              ...ambiguous,
              candidates: [{ personId: "person-bo-other", name: "Bo Berg" }],
            },
            failed,
            updated,
          ],
        },
      }),
    });

    await session.selectOptions(
      screen.getByRole("combobox", { name: /Den här raden är/ }),
      "person-bo-senior",
    );
    await session.click(
      screen.getByRole("button", { name: /Genomför importen/ }),
    );

    expect(
      await screen.findByText(/förhandsgranskningen har gjorts om/),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("combobox", {
          name: /Den här raden är/,
        }) as HTMLSelectElement
      ).value,
    ).toBe("");
    expect(
      screen
        .getByRole("button", { name: /Genomför importen/ })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps the preview when another import is running", async () => {
    // A different file is being imported - by another board member, or from a
    // tab opened before it started. This upload was not started, so the
    // preview the board member checked stays on the screen to run afterwards.
    const session = userEvent.setup();
    await reachPreview(session);

    applyImport.mockResolvedValue({
      ok: false,
      failure: { status: 409, reason: "another-import-running" },
    });

    await session.selectOptions(
      screen.getByRole("combobox", { name: /Den här raden är/ }),
      "skip",
    );
    await session.click(
      screen.getByRole("button", { name: /Genomför importen/ }),
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/En annan import pågår/)).toBeTruthy();
    expect(screen.getByText(/Vad detta skulle göra/)).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /Genomför importen/ })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(fetchActiveImport).toHaveBeenCalledTimes(1);
  });

  it("follows the import to the end", async () => {
    await apply();
    await screen.findByText(/Importen pågår/);

    // The screen asks again on its own; the wait is the poll interval, which is
    // what a board member also waits.
    expect(
      await screen.findByText(/Importen är klar/, undefined, {
        timeout: 5000,
      }),
    ).toBeTruthy();
    expect(screen.getByText(/3 av 3 rader/)).toBeTruthy();
    expect(fetchImportRun).toHaveBeenCalledWith("session-1");
  }, 10_000);
});

describe("coming back to the screen", () => {
  it("finds the import that is still running", async () => {
    // A reload, or a tab closed and opened again: the screen holds nothing that
    // identifies the import, so it asks for the one that is running.
    fetchActiveImport.mockResolvedValue({
      ok: true,
      value: runView({
        status: "APPLYING",
        rowsDone: 40,
        rowsTotal: 120,
        result: { ...FINISHED.result, personsCreated: 12 },
      }),
    });
    render(<ImportScreen />);

    expect(await screen.findByText(/Skriver registret/)).toBeTruthy();
    expect(screen.getByText(/40 av 120 rader/)).toBeTruthy();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    // Not the upload form: an import is under way, and offering another one
    // would invite a second write into a register nothing can edit.
    expect(screen.queryByLabelText(/Välj en fil/)).toBeNull();
  });

  it("says an import stopped, and how far it got", async () => {
    fetchActiveImport.mockResolvedValue({
      ok: true,
      value: runView({
        status: "FAILED",
        rowsDone: 100,
        rowsTotal: 120,
        failureReason: "apply-interrupted",
        result: { ...FINISHED.result, personsCreated: 40 },
      }),
    });
    render(<ImportScreen />);

    expect(await screen.findByText(/Importen stoppades$/)).toBeTruthy();
    expect(screen.getByText(/nådde filens slut/)).toBeTruthy();
    expect(screen.getByText(/100 av 120 rader/)).toBeTruthy();
    // What it did write is in the register, so the count is shown rather than
    // hidden behind the failure.
    expect(screen.getByText("40")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Importera en annan lista/ }),
    ).toBeTruthy();
  });

  it("says which refusal stopped an import, not that it was interrupted", async () => {
    // A refusal and an interruption call for two different things from a board
    // member: one is answered by fixing the mapping, the other by importing
    // what is left as a new file. The job records the reason it actually had,
    // and it has to reach the screen as that reason.
    fetchActiveImport.mockResolvedValue({
      ok: true,
      value: runView({
        status: "FAILED",
        rowsDone: 0,
        rowsTotal: 120,
        failureReason: "mapping-invalid",
      }),
    });
    render(<ImportScreen />);

    expect(
      await screen.findByText(/Kopplingen går inte att använda ännu/),
    ).toBeTruthy();
    expect(screen.queryByText(/nådde filens slut/)).toBeNull();
  });

  it("offers the upload again when nothing is running", async () => {
    render(<ImportScreen />);

    expect(await screen.findByLabelText(/Välj en fil/)).toBeTruthy();
  });
});

describe("when the file cannot be read", () => {
  it("says when a quotation mark is never closed", async () => {
    uploadImport.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "unterminated-quote" },
    });
    const session = userEvent.setup();
    render(<ImportScreen />);

    await session.upload(screen.getByLabelText(/Välj en fil/), file());
    await session.click(screen.getByRole("button", { name: /Läs filen/ }));

    expect(
      await screen.findByText(/citattecken i filen avslutas aldrig/),
    ).toBeTruthy();
  });

  it("names the row cap a file went over", async () => {
    uploadImport.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "too-many-rows" },
    });
    const session = userEvent.setup();
    render(<ImportScreen />);

    await session.upload(screen.getByLabelText(/Välj en fil/), file());
    await session.click(screen.getByRole("button", { name: /Läs filen/ }));

    // Written as Swedish writes a number, from the cap the API enforces.
    expect(await screen.findByText(/fler än 5\s000 rader/)).toBeTruthy();
  });

  it("says which problem it was", async () => {
    uploadImport.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "file-unreadable" },
    });
    const session = userEvent.setup();
    render(<ImportScreen />);

    await session.upload(screen.getByLabelText(/Välj en fil/), file());
    await session.click(screen.getByRole("button", { name: /Läs filen/ }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      screen.getByText(/gick inte att läsa som ett kalkylblad/),
    ).toBeTruthy();
  });
});
