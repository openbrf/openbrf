import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

import "../i18n";
import { InitialSupplyScreen } from "./InitialSupplyScreen";
import type { InitialSupply } from "./registers-api";

/**
 * The initial supply to the cooperative housing register.
 *
 * The disclosure is what these tests defend. The file carries a personal
 * identity number for every current holder, so the screen must not produce one
 * as a side effect of being opened, must say what the file contains before
 * anybody asks for it, and must say plainly that the shape is Open BRF's own
 * rather than a format Lantmateriet published. A refusal is the ordinary answer
 * for somebody who may read the register and not supply it, so it reads as that
 * and not as a fault.
 */

const produceInitialSupply = vi.fn();

vi.mock("./registers-api", () => ({
  produceInitialSupply: () => produceInitialSupply(),
}));

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
    <a className={className} href={to}>
      {children}
    </a>
  ),
}));

const CSV =
  "﻿recordType;apartmentKey;holderName;holderPersonalIdentityNumber\r\n" +
  "HOLDER;Bokgatan 3 1101;Mira Berg;199001011234\r\n";

const SUPPLY: InitialSupply = {
  generatedOn: "2027-11-30",
  fileName: "bostadsrattsregister-uppgifter-2027-11-30.csv",
  columns: [
    "recordType",
    "apartmentKey",
    "apartmentNumber",
    "holderName",
    "holderPersonalIdentityNumber",
    "holderProtectedPersonalData",
    "pledgeCreditor",
  ],
  rows: [
    {
      recordType: "APARTMENT",
      apartmentKey: "Bokgatan 3 1101",
      apartmentNumber: "1101",
    },
    {
      recordType: "HOLDER",
      apartmentKey: "Bokgatan 3 1101",
      holderName: "Mira Berg",
      holderPersonalIdentityNumber: "199001011234",
      holderProtectedPersonalData: "no",
    },
    {
      recordType: "PLEDGE",
      apartmentKey: "Bokgatan 3 1101",
      pledgeCreditor: "Bokbanken",
    },
  ],
  counts: { ASSOCIATION: 1, APARTMENT: 1, HOLDER: 1, PLEDGE: 1 },
  csv: CSV,
};

beforeEach(() => {
  produceInitialSupply
    .mockReset()
    .mockResolvedValue({ ok: true, value: SUPPLY });
});

describe("opening the screen", () => {
  it("produces nothing until somebody asks", async () => {
    /*
     * The load-bearing assertion. Producing the file decrypts every current
     * holder's personal identity number and writes an audit entry naming them,
     * so a fetch on mount would make an audited disclosure a consequence of
     * following a link rather than an act somebody chose to take.
     */
    render(<InitialSupplyScreen />);

    expect(
      await screen.findByRole("button", {
        name: "Ta fram det inledande uppgiftslämnandet",
      }),
    ).toBeTruthy();
    expect(produceInitialSupply).not.toHaveBeenCalled();
    expect(screen.queryByText("199001011234")).toBeNull();
  });

  it("says what the file will contain, before it exists", async () => {
    render(<InitialSupplyScreen />);

    expect(
      await screen.findByText(/innehåller personnummer för varje nuvarande/),
    ).toBeTruthy();
    expect(screen.getByText(/skrivs till granskningsloggen/)).toBeTruthy();
  });

  it("says the shape is Open BRF's own and not Lantmäteriet's", async () => {
    // The whole reason the file is documented rather than guessed at. A board
    // told nothing would reasonably assume it is sending an official format.
    render(<InitialSupplyScreen />);

    expect(
      await screen.findByText(/inte ett format från Lantmäteriet/),
    ).toBeTruthy();
    expect(screen.getByText(/docs\/register-supply-contract\.md/)).toBeTruthy();
  });
});

describe("the produced document", () => {
  it("prints the rows the file carries, under the file's own column names", async () => {
    /*
     * Not a prettier rendering of them. A board member signing off on what goes
     * to Lantmateriet is checking the file, and a summary would be a second
     * thing to get right whose being wrong nobody would notice.
     */
    const session = userEvent.setup();
    render(<InitialSupplyScreen />);

    await session.click(
      screen.getByRole("button", {
        name: "Ta fram det inledande uppgiftslämnandet",
      }),
    );

    expect(
      await screen.findByRole("columnheader", {
        name: "holderPersonalIdentityNumber",
      }),
    ).toBeTruthy();
    expect(screen.getByText("Mira Berg")).toBeTruthy();
    expect(screen.getByText("199001011234")).toBeTruthy();
    expect(screen.getByText("Bokbanken")).toBeTruthy();
  });

  it("leaves out the columns a record type does not fill", async () => {
    // The file keeps every column on every row, because a delimited file is read
    // by position. A printed page of mostly empty cells is a page nobody checks.
    const session = userEvent.setup();
    render(<InitialSupplyScreen />);

    await session.click(
      screen.getByRole("button", {
        name: "Ta fram det inledande uppgiftslämnandet",
      }),
    );
    await screen.findByRole("heading", { name: "Pantnotering" });

    expect(
      screen.queryAllByRole("columnheader", { name: "pledgeCreditor" }),
    ).toHaveLength(1);
  });

  it("offers the file as a download named for the day it was produced", async () => {
    const session = userEvent.setup();
    render(<InitialSupplyScreen />);

    await session.click(
      screen.getByRole("button", {
        name: "Ta fram det inledande uppgiftslämnandet",
      }),
    );

    const link = await screen.findByRole("link", { name: "Spara filen" });
    expect(link.getAttribute("download")).toBe(
      "bostadsrattsregister-uppgifter-2027-11-30.csv",
    );
    // The bytes the API produced, not bytes this screen serialised: the column
    // contract has one implementation and it is not in the browser. The byte
    // order mark survives the encoding, which is what makes a spreadsheet read
    // the file as UTF-8.
    const href = link.getAttribute("href") ?? "";
    expect(href.startsWith("data:text/csv;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(href.split(",")[1] ?? "")).toBe(CSV);
  });

  it("says the copy was written to the audit log", async () => {
    const session = userEvent.setup();
    render(<InitialSupplyScreen />);

    await session.click(
      screen.getByRole("button", {
        name: "Ta fram det inledande uppgiftslämnandet",
      }),
    );

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByText(/skrevs till granskningsloggen/)).toBeTruthy();
  });
});

describe("a caller who may read the register but not supply it", () => {
  it("is told it needs a permission of its own", async () => {
    const session = userEvent.setup();
    produceInitialSupply.mockResolvedValue({
      ok: false,
      failure: { status: 403, reason: "forbidden" },
    });
    render(<InitialSupplyScreen />);

    await session.click(
      screen.getByRole("button", {
        name: "Ta fram det inledande uppgiftslämnandet",
      }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("egen behörighet");
    // And no document, so a refusal cannot leave a half-rendered file on screen.
    await waitFor(() => {
      expect(screen.queryByText("199001011234")).toBeNull();
    });
    expect(screen.queryByRole("link", { name: "Spara filen" })).toBeNull();
  });
});
