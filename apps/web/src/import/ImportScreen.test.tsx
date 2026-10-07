import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { ImportScreen } from "./ImportScreen";
import type {
  ImportPreview,
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
const applyImport = vi.fn();
const fetchImportRun = vi.fn();
const fetchActiveImport = vi.fn();
const abandonImport = vi.fn();

vi.mock("./import-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./import-api")>()),
  uploadImport: (input: unknown) => uploadImport(input),
  previewImport: (sessionId: string, input: unknown) =>
    previewImport(sessionId, input),
  applyImport: (sessionId: string, input: unknown) =>
    applyImport(sessionId, input),
  fetchImportRun: (sessionId: string) => fetchImportRun(sessionId),
  fetchActiveImport: () => fetchActiveImport(),
  abandonImport: (sessionId: string) => abandonImport(sessionId),
}));

/**
 * What the signed-in account may do. A board member unless a case says
 * otherwise: the board imports, and only an administrator may abandon.
 */
const capabilities = vi.fn<() => readonly string[]>();

vi.mock("../shell/use-viewer-capabilities", () => ({
  useViewerCapabilities: () => capabilities(),
}));

const BOARD = ["addressBook:read", "addressBook:write"];
const ADMINISTRATOR = [...BOARD, "association:manage"];

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
      sourceRow: 2,
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
      sourceRow: 3,
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
      sourceRow: 4,
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
      sourceRow: 5,
      candidates: [],
      problems: [],
    },
  ],
};

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
  previewImport.mockReset().mockResolvedValue({ ok: true, value: PREVIEW });
  // The apply is accepted, not done: what comes back is a queued import.
  applyImport.mockReset().mockResolvedValue({ ok: true, value: runView() });
  fetchImportRun.mockReset().mockResolvedValue({ ok: true, value: FINISHED });
  fetchActiveImport.mockReset().mockResolvedValue({ ok: true, value: null });
  abandonImport.mockReset();
  capabilities.mockReset().mockReturnValue(BOARD);
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
      value: {
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
      value: {
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
      value: {
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
      value: {
        ...PREVIEW,
        rows: [
          {
            ...garbled,
            person: { ...garbled.person, firstName: "Bj\uFFFDrk" },
            problems: [{ field: "firstName", reason: "garbled-characters" }],
          },
        ],
      },
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
      value: {
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
      value: {
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

  it("keeps the preview when somebody else previewed the file meanwhile", async () => {
    // Another tab or board member previewed this upload while the apply was
    // starting. Nothing this board member chose changed, and previewing again
    // from here would quietly replace the other preview.
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

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(
      screen.getByText(/Någon förhandsgranskade importen igen/),
    ).toBeTruthy();
    expect(screen.queryByText(/förhandsgranskningen har gjorts om/)).toBeNull();
    expect(previewImport).toHaveBeenCalledTimes(1);
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

  it("tells the board how to fix a file that mixes encodings", async () => {
    uploadImport.mockResolvedValue({
      ok: false,
      failure: { status: 400, reason: "file-mixed-encoding" },
    });
    const session = userEvent.setup();
    render(<ImportScreen />);

    await session.upload(screen.getByLabelText(/Välj en fil/), file());
    await session.click(screen.getByRole("button", { name: /Läs filen/ }));

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Spara om filen som UTF-8 eller som/)).toBeTruthy();
    expect(screen.getByText(/CSV \(semikolonavgränsad\)/)).toBeTruthy();
    expect(
      screen.queryByText(/gick inte att läsa som ett kalkylblad/),
    ).toBeNull();
  });
});

describe("an import that has stopped moving", () => {
  const STUCK = runView({ status: "APPLYING", rowsDone: 100, rowsTotal: 120 });

  beforeEach(() => {
    fetchActiveImport.mockResolvedValue({ ok: true, value: STUCK });
    // Still running every time the screen asks, which is what stuck looks like.
    fetchImportRun.mockResolvedValue({ ok: true, value: STUCK });
  });

  it("is not offered to the board", async () => {
    // The API refuses anybody without association:manage, so a board member
    // shown the control would only ever get a refusal.
    render(<ImportScreen />);

    expect(await screen.findByText(/Skriver registret/)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Avbryt importen/ }),
    ).toBeNull();
  });

  it("asks an administrator twice, then shows it stopped", async () => {
    capabilities.mockReturnValue(ADMINISTRATOR);
    const abandoned = runView({
      status: "FAILED",
      rowsDone: 100,
      rowsTotal: 120,
      failureReason: "apply-abandoned",
      finishedAt: "2026-10-03T09:00:00.000Z",
    });
    abandonImport.mockResolvedValue({ ok: true, value: abandoned });
    fetchImportRun.mockResolvedValue({ ok: true, value: abandoned });
    const session = userEvent.setup();
    render(<ImportScreen />);

    await session.click(
      await screen.findByRole("button", { name: /Avbryt importen/ }),
    );
    // The first press only asks: it stops an import part way through a
    // register that cannot be edited.
    expect(abandonImport).not.toHaveBeenCalled();
    expect(screen.getByText(/finns kvar i medlemsförteckningen/)).toBeTruthy();

    await session.click(screen.getByRole("button", { name: /Ja, avbryt den/ }));

    expect(abandonImport).toHaveBeenCalledWith("session-1");
    expect(await screen.findByText(/Importen stoppades$/)).toBeTruthy();
    expect(screen.getByText(/En administratör avbröt importen/)).toBeTruthy();
    expect(screen.getByText(/100 av 120 rader/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Importera en annan lista/ }),
    ).toBeTruthy();
  });

  it("lets an administrator change their mind", async () => {
    capabilities.mockReturnValue(ADMINISTRATOR);
    const session = userEvent.setup();
    render(<ImportScreen />);

    await session.click(
      await screen.findByRole("button", { name: /Avbryt importen/ }),
    );
    await session.click(
      screen.getByRole("button", { name: /Låt den fortsätta/ }),
    );

    expect(abandonImport).not.toHaveBeenCalled();
    expect(screen.getByText(/Skriver registret/)).toBeTruthy();
  });

  it("says so when the import ended before the press, and keeps saying it", async () => {
    capabilities.mockReturnValue(ADMINISTRATOR);
    // The import finished between the screen's last poll and the press, so
    // the API refuses and the next poll brings in the finished import.
    abandonImport.mockImplementation(() => {
      fetchImportRun.mockResolvedValue({
        ok: true,
        value: { ...FINISHED, rowsDone: 120, rowsTotal: 120 },
      });
      return Promise.resolve({
        ok: false,
        failure: { status: 409, reason: "session-not-running" },
      });
    });
    const session = userEvent.setup();
    render(<ImportScreen />);

    await session.click(
      await screen.findByRole("button", { name: /Avbryt importen/ }),
    );
    await session.click(screen.getByRole("button", { name: /Ja, avbryt den/ }));

    expect(
      await screen.findByText(/Den importen pågår inte längre/),
    ).toBeTruthy();
    // The poll takes the control away. The notice stays, to say why the press
    // did nothing.
    expect(
      await screen.findByText(/Importen är klar/, undefined, {
        timeout: 5000,
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Avbryt importen/ }),
    ).toBeNull();
    expect(screen.getByText(/Den importen pågår inte längre/)).toBeTruthy();
  }, 10_000);
});
