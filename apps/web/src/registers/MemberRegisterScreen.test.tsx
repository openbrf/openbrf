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
const ALTERNATIVE_ADDRESS = "c/o Skatteverket, Box 1, 111 22 Stockholm";

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
      // A protected member whose row arrived carrying a visible address.
      // Masking is the server's contract and this fixture breaks it on
      // purpose: the extract is public on request, so the screen withholds the
      // address on the row's own protected flag rather than on the shape it
      // was handed.
      key: "person-sara:entry-2",
      personId: "person-sara",
      name: "Sara Berg",
      postalAddress: {
        state: "visible",
        street: PROTECTED_ADDRESS,
        postalCode: "11133",
        city: "Stockholm",
      },
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
    {
      // Protected, with an address the person agreed may stand in for theirs.
      // The permitted alternative is printed; nothing else about where they
      // live is.
      key: "person-nils:entry-3",
      personId: "person-nils",
      name: "Nils Ek",
      postalAddress: {
        state: "masked",
        alternativePostalAddress: ALTERNATIVE_ADDRESS,
      },
      protectedPersonalData: true,
      enteredOn: "2022-09-01",
      exitedOn: null,
      apartments: [
        {
          id: "apartment-1202",
          number: "1202",
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
    // The fixture hands this row a visible address, which is the mistake the
    // assertion is here to catch: the extract is public on request, and an
    // address printed on it cannot be recalled once the copy is handed over.
    render(<MemberRegisterScreen />);

    expect(await screen.findByText("Sara Berg")).toBeTruthy();
    expect(screen.queryByText(new RegExp(PROTECTED_ADDRESS))).toBeNull();
    expect(screen.getByText(/Skyddad, skrivs inte ut/)).toBeTruthy();
  });

  it("prints the alternative address a protected member agreed to", async () => {
    // The register has to state an address, and a person with protected data
    // may give one that is safe to print. Withholding that too would leave the
    // document saying less than the person asked it to.
    render(<MemberRegisterScreen />);

    expect(await screen.findByText(ALTERNATIVE_ADDRESS)).toBeTruthy();
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
