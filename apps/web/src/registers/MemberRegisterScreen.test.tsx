import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import { MemberRegisterScreen } from "./MemberRegisterScreen";
import type { MemberRegisterExtract } from "./registers-api";

/**
 * The member register extract.
 *
 * The assertions that matter are the ones a screenshot review would miss: that
 * this document carries no personal identity number and says so, that a
 * protected member's address is not printed, and that the stamp names this
 * register rather than the other one. The first is the reason the extract can be
 * public on request at all.
 */

const fetchMemberRegister = vi.fn();

vi.mock("./registers-api", () => ({
  fetchMemberRegister: (scope: string) => fetchMemberRegister(scope),
}));

const PROTECTED_ADDRESS = "Hemliga gatan 1";

const EXTRACT: MemberRegisterExtract = {
  housingCooperative: {
    name: "Brf Eksemplet",
    organizationNumber: "769600-0000",
  },
  scope: "current",
  generatedOn: "2026-08-28",
  rows: [
    {
      key: "person-anna:entry-1",
      personId: "person-anna",
      name: "Anna Lindqvist",
      postalAddress: {
        state: "visible",
        street: "Storgatan 12",
        postalCode: "11122",
        city: "Stockholm",
      },
      protectedPersonalData: false,
      enteredOn: "2019-06-01",
      exitedOn: null,
      apartments: [
        {
          id: "apartment-1103",
          number: "1103",
          addressLabel: "Storgatan 12",
        },
      ],
    },
    {
      key: "person-sara:entry-2",
      personId: "person-sara",
      name: "Sara Berg",
      postalAddress: { state: "masked", alternativePostalAddress: null },
      protectedPersonalData: true,
      enteredOn: "2021-02-01",
      exitedOn: null,
      apartments: [
        {
          id: "apartment-1201",
          number: "1201",
          addressLabel: "Storgatan 12",
        },
      ],
    },
  ],
};

beforeEach(() => {
  fetchMemberRegister
    .mockReset()
    .mockResolvedValue({ ok: true, value: EXTRACT });
});

describe("the extract", () => {
  it("heads the columns the statute prescribes, and no others", async () => {
    render(<MemberRegisterScreen />);

    for (const head of [
      "Namn",
      "Postadress",
      "Lägenhet",
      "Medlem sedan",
      "Medlemskap upphörde",
    ]) {
      expect(
        await screen.findByRole("columnheader", { name: head }),
      ).toBeTruthy();
    }
    expect(
      screen.queryByRole("columnheader", { name: /Personnummer/ }),
    ).toBeNull();
  });

  it("says on the document that it carries no personal identity numbers", async () => {
    // Somebody handed this extract should be able to see that the absence is
    // the rule rather than a gap in the register.
    render(<MemberRegisterScreen />);

    expect(
      await screen.findByText(/innehåller inga personnummer/i),
    ).toBeTruthy();
  });

  it("does not print a protected member's address", async () => {
    render(<MemberRegisterScreen />);

    expect(await screen.findByText("Sara Berg")).toBeTruthy();
    expect(screen.queryByText(new RegExp(PROTECTED_ADDRESS))).toBeNull();
    expect(screen.getByText(/Skyddad, skrivs inte ut/)).toBeTruthy();
  });

  it("keeps an unprotected member's address, which the register has to state", async () => {
    render(<MemberRegisterScreen />);

    expect(
      await screen.findByText(/Storgatan 12, 11122, Stockholm/),
    ).toBeTruthy();
  });

  it("stamps the member register, not the apartment register", async () => {
    render(<MemberRegisterScreen />);

    expect(
      await screen.findByText(/Utdrag ur medlemsförteckningen/),
    ).toBeTruthy();
    expect(screen.queryByText(/lägenhetsförteckningen/)).toBeNull();
  });

  it("names the housing cooperative and its organisation number", async () => {
    render(<MemberRegisterScreen />);

    expect(await screen.findByText("Brf Eksemplet")).toBeTruthy();
    expect(screen.getByText(/769600-0000/)).toBeTruthy();
  });
});

describe("the scope", () => {
  it("asks the server again when former members are included", async () => {
    const session = userEvent.setup();
    render(<MemberRegisterScreen />);

    await screen.findByText("Anna Lindqvist");
    await session.click(screen.getByRole("radio", { name: /tidigare/i }));

    await waitFor(() => {
      expect(fetchMemberRegister).toHaveBeenCalledWith("all");
    });
  });
});

describe("when the register cannot be read", () => {
  it("says so rather than showing an empty document", async () => {
    fetchMemberRegister.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });
    render(<MemberRegisterScreen />);

    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});
