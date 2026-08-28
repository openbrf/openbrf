import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { ImportScreen } from "./ImportScreen";
import type { ImportPreview, ImportSessionView } from "./import-api";

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
 */

const IDENTITY_NUMBER = "19811228-9874";

const uploadImport = vi.fn();
const previewImport = vi.fn();
const applyImport = vi.fn();

vi.mock("./import-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./import-api")>()),
  uploadImport: (input: unknown) => uploadImport(input),
  previewImport: (sessionId: string, input: unknown) =>
    previewImport(sessionId, input),
  applyImport: (sessionId: string, input: unknown) =>
    applyImport(sessionId, input),
}));

const SESSION: ImportSessionView = {
  sessionId: "session-1",
  fileName: "medlemmar.csv",
  format: "CSV",
  columns: ["Lgh", "Namn", "E-post"],
  rowCount: 3,
  sample: [["1103", "Anna Lindqvist", "anna@exempel.se"]],
  suggestedMapping: ["apartmentNumber", "fullName", "email"],
  expiresAt: "2026-08-29T00:00:00.000Z",
};

const PREVIEW: ImportPreview = {
  sessionId: "session-1",
  summary: { create: 1, update: 0, ambiguous: 1, error: 1 },
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
      matchedBy: null,
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
      matchedBy: "apartmentAndName",
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
      matchedBy: null,
      sameAsRowNumber: null,
      candidates: [],
      problems: [{ field: "movedInOn", reason: "date-not-iso" }],
    },
  ],
};

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

beforeEach(() => {
  uploadImport.mockReset().mockResolvedValue({ ok: true, value: SESSION });
  previewImport.mockReset().mockResolvedValue({ ok: true, value: PREVIEW });
  applyImport.mockReset().mockResolvedValue({
    ok: true,
    value: {
      personsCreated: 1,
      personsUpdated: 1,
      residenciesCreated: 2,
      memberRegisterEntriesCreated: 1,
      skipped: 0,
      errors: 1,
    },
  });
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
  });

  it("names what is wrong with a row rather than dropping it", async () => {
    const session = userEvent.setup();
    await reachPreview(session);

    expect(screen.getByText(/ÅÅÅÅ-MM-DD/)).toBeTruthy();
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

describe("after the import", () => {
  it("says the register entries it wrote cannot be edited", async () => {
    const session = userEvent.setup();
    await reachPreview(session);

    await session.selectOptions(
      screen.getByRole("combobox", { name: /Den här raden är/ }),
      "skip",
    );
    await session.click(
      screen.getByRole("button", { name: /Genomför importen/ }),
    );

    expect(await screen.findByText(/Importen är klar/)).toBeTruthy();
    expect(screen.getByText(/går inte att ändra eller ta bort/)).toBeTruthy();
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
});
