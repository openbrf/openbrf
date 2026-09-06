import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { Viewer } from "../api/instance";
import type { OwnSubletApplication } from "../api/sublets";
import { SubletsScreen } from "./SubletsScreen";

/**
 * Which half of the subletting screen a seat is given, and the one act on it
 * that is not the board's own decision.
 *
 * The API refuses every call whatever the browser was shown, so hiding a panel
 * is courtesy. What is not courtesy is the read behind it: the board's queue is
 * the one place an application says which member wants to let their flat and
 * why, and a screen that asked for it on a member's behalf would be asking the
 * server for other people's data on a page with nowhere to put it. So this file
 * asserts the request as well as the panel.
 *
 * The split is a statute rather than a product decision. `sublets:apply` is
 * derived from membership under BRL 7 kap. 10 § första stycket, which lets a
 * bostadsrättshavare let *sin lägenhet* in andra hand with the board's consent,
 * so a resident who holds no tenant-ownership is offered no form;
 * `sublets:handle` is the board's, because the same paragraph names the styrelse
 * as who gives the consent. A board member who is not a member gets the queue
 * and no form, which is the same rule read from the other end and the case a
 * screen written around "resident or board" would get wrong.
 *
 * And 7 kap. 11 §: where the board refuses, the rent tribunal may permit the
 * letting anyway. That is recorded and never derived, so the control for it
 * exists on a refused row and nowhere else - and recording one must leave the
 * row saying the association refused, because it did.
 */

const fetchSubletIntake = vi.fn();
const fetchSubletQueue = vi.fn();
const decideSubletApplication = vi.fn();
const recordSubletTribunalPermission = vi.fn();
const withdrawSubletApplication = vi.fn();
const reviseSubletApplication = vi.fn();

vi.mock("../api/sublets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/sublets")>()),
  fetchSubletIntake: () => fetchSubletIntake(),
  fetchSubletQueue: () => fetchSubletQueue(),
  decideSubletApplication: (input: unknown) => decideSubletApplication(input),
  recordSubletTribunalPermission: (input: unknown) =>
    recordSubletTribunalPermission(input),
  withdrawSubletApplication: (input: unknown) =>
    withdrawSubletApplication(input),
  reviseSubletApplication: (input: unknown) => reviseSubletApplication(input),
}));

function viewer(capabilities: readonly string[]): Viewer {
  return {
    personId: "person-maja",
    firstName: "Maja",
    lastName: "Medlem",
    preferredLocale: "sv",
    capabilities: [...capabilities],
    housingCooperative: null,
  };
}

const APARTMENT = {
  id: "apartment-1201",
  number: "1201",
  address: "Storgatan 12",
};

const OPEN_APPLICATION: OwnSubletApplication = {
  id: "sublet-1",
  apartment: APARTMENT,
  periodFrom: "2029-02-01",
  periodTo: "2029-08-31",
  reason: "Provbo på annan ort under ett halvår.",
  status: "SUBMITTED",
  submittedAt: "2028-11-02T09:00:00.000Z",
  closedAt: null,
  decisionNote: null,
  tribunalPermission: null,
};

/** The state BRL 7 kap. 11 § opens the rent tribunal route from. */
const REFUSED_APPLICATION: OwnSubletApplication = {
  ...OPEN_APPLICATION,
  id: "sublet-2",
  status: "REFUSED",
  closedAt: "2028-11-20T12:00:00.000Z",
  decisionNote: "Föreningen har redan två upplåtelser i uppgången.",
  tribunalPermission: null,
};

const APPLICANT = {
  kind: "member" as const,
  personId: "person-maja",
  name: "Maja Medlem",
};

beforeEach(() => {
  fetchSubletIntake.mockReset().mockResolvedValue({
    ok: true,
    value: { apartments: [APARTMENT], applications: [OPEN_APPLICATION] },
  });
  fetchSubletQueue.mockReset().mockResolvedValue({
    ok: true,
    value: {
      applications: [
        { ...OPEN_APPLICATION, applicant: APPLICANT, closedByPersonId: null },
      ],
    },
  });
  decideSubletApplication.mockReset().mockResolvedValue({
    ok: true,
    value: {
      ...REFUSED_APPLICATION,
      applicant: APPLICANT,
      closedByPersonId: "person-bea",
    },
  });
  recordSubletTribunalPermission.mockReset().mockResolvedValue({
    ok: true,
    value: {
      ...REFUSED_APPLICATION,
      tribunalPermission: {
        permittedOn: "2028-12-15",
        permittedUntil: "2029-08-31",
      },
      applicant: APPLICANT,
      closedByPersonId: "person-bea",
    },
  });
  withdrawSubletApplication.mockReset();
  reviseSubletApplication.mockReset();
});

describe("a member", () => {
  it("is offered the form and their own applications, and never the queue", async () => {
    render(<SubletsScreen viewer={viewer(["sublets:apply"])} />);

    await screen.findByText("Begär styrelsens samtycke");
    expect(screen.getByText("Dina ansökningar")).not.toBeNull();
    expect(
      screen.queryByText("Ansökningar om andrahandsupplåtelse"),
    ).toBeNull();

    /*
     * And the read behind the panel was never issued. The queue says which
     * member wants to let their flat and why, and a page with nowhere to put
     * that must not ask for it - asserting only the missing heading would pass
     * while the request went out.
     */
    expect(fetchSubletQueue).not.toHaveBeenCalled();
    expect(fetchSubletIntake).toHaveBeenCalledTimes(1);
  });

  it("is offered their own apartments and no other", async () => {
    // The only list of apartments this module discloses. A picker over the
    // register would enumerate the building to whoever loaded the form.
    render(<SubletsScreen viewer={viewer(["sublets:apply"])} />);

    await screen.findByText("Begär styrelsens samtycke");
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "Storgatan 12 1201",
    ]);
  });

  it("is told the rule about independent use rather than judged by it", async () => {
    /*
     * BRL 7 kap. 10 § andra stycket turns on whether the holder still uses the
     * apartment as a permanent home or otherwise in beaktansvärd utsträckning,
     * which is a fact about how somebody lives that this platform does not hold.
     * Stating it is the whole of what the screen can honestly do.
     */
    render(<SubletsScreen viewer={viewer(["sublets:apply"])} />);

    await screen.findByText("Begär styrelsens samtycke");
    expect(
      screen.getByText(/självständigt brukande.*permanentbostad/s),
    ).not.toBeNull();
  });

  it("is told a refusal is not the end of it", async () => {
    // A member told only "Nekad" has been told the smaller half: 7 kap. 11 §
    // lets the rent tribunal permit what the board refused.
    fetchSubletIntake.mockResolvedValue({
      ok: true,
      value: { apartments: [APARTMENT], applications: [REFUSED_APPLICATION] },
    });

    render(<SubletsScreen viewer={viewer(["sublets:apply"])} />);

    await screen.findByText("Dina ansökningar");
    expect(screen.getByText(/hyresnämnden lämnar tillstånd/i)).not.toBeNull();
  });

  it("has no apartment to apply about, and is told so rather than shown a form", async () => {
    fetchSubletIntake.mockResolvedValue({
      ok: true,
      value: { apartments: [], applications: [] },
    });

    render(<SubletsScreen viewer={viewer(["sublets:apply"])} />);

    await screen.findByText("Begär styrelsens samtycke");
    expect(
      screen.getByText(/innehar ingen lägenhet i föreningen/),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Skicka ansökan" })).toBeNull();
  });
});

describe("a resident who is not a member", () => {
  it("is offered neither half", async () => {
    // BRL 7 kap. 10 § gives the act to the bostadsrättshavare, so a partner, an
    // adult child or a tenant living in the flat holds nothing here.
    render(<SubletsScreen viewer={viewer(["self:manage"])} />);

    await screen.findByRole("heading", { name: "Hyra ut i andra hand" });
    expect(screen.queryByText("Begär styrelsens samtycke")).toBeNull();
    expect(
      screen.queryByText("Ansökningar om andrahandsupplåtelse"),
    ).toBeNull();
    expect(fetchSubletIntake).not.toHaveBeenCalled();
    expect(fetchSubletQueue).not.toHaveBeenCalled();
  });
});

describe("the board", () => {
  it("is not told who applied where the register protects their name", async () => {
    /*
     * Skyddade personuppgifter. The board's own address book prints the name and
     * this queue deliberately does not: the queue is a working list rather than
     * a register, and a board member who has to reach the person goes through
     * the register that has a reason to name them. The apartment stays, because
     * the consent under BRL 7 kap. 10 § is about a named apartment.
     *
     * Asserted on the absence of the name as well as on the substitute. The
     * projection is the server's, so a client that had started printing
     * `applicant.name` for every kind would still pass a test that only looked
     * for the substitute sentence somewhere on the page.
     */
    fetchSubletQueue.mockResolvedValue({
      ok: true,
      value: {
        applications: [
          {
            ...OPEN_APPLICATION,
            applicant: { kind: "protected", personId: "person-maja" },
            closedByPersonId: null,
          },
        ],
      },
    });

    render(<SubletsScreen viewer={viewer(["sublets:handle"])} />);

    await screen.findByText("Ansökningar om andrahandsupplåtelse");
    expect(screen.queryByText("Maja Medlem")).toBeNull();
    expect(
      screen.getByText("Skyddade personuppgifter: fråga registret."),
    ).not.toBeNull();
    expect(screen.getByText("Storgatan 12 1201")).not.toBeNull();
  });

  it("is shown no queue at all where the queue could not be read", async () => {
    /*
     * An empty list and a list that failed to arrive are different answers, and
     * the panel has words for only one of them: handed no applications it says
     * no member is waiting for the board's consent. The consent is the board's
     * own to give under BRL 7 kap. 10 §, so that sentence is the association
     * telling the people who decide that there is nothing to decide - said from
     * a request that never answered, and not undone by a notice above it.
     */
    fetchSubletQueue.mockResolvedValue({
      ok: false,
      failure: { status: 500, reason: "unexpected" },
    });

    render(
      <SubletsScreen viewer={viewer(["sublets:apply", "sublets:handle"])} />,
    );

    await screen.findByText(
      "Ansökningarna om andrahandsupplåtelse kunde inte läsas just nu.",
    );
    expect(
      screen.queryByText("Ansökningar om andrahandsupplåtelse"),
    ).toBeNull();
    expect(screen.queryByText("Ingen medlem har begärt samtycke.")).toBeNull();

    // And the half that did answer is untouched by the other's failure.
    expect(screen.getByText("Begär styrelsens samtycke")).not.toBeNull();
  });

  it("is offered the queue, and no form where it holds no tenant-ownership", async () => {
    // The same rule read from the other end: the consent is the board's to give
    // and the application is the member's to make, and a board member who holds
    // no tenant-ownership makes none.
    render(<SubletsScreen viewer={viewer(["sublets:handle"])} />);

    await screen.findByText("Ansökningar om andrahandsupplåtelse");
    expect(screen.queryByText("Begär styrelsens samtycke")).toBeNull();
    expect(fetchSubletIntake).not.toHaveBeenCalled();
  });

  it("is offered the rent tribunal record on a refused row and nowhere else", async () => {
    /*
     * The control exists on a refused row only, because 7 kap. 11 § opens that
     * route only from a refusal and the server refuses it anywhere else.
     * Offering it on an open row would be a control that could only fail.
     */
    render(<SubletsScreen viewer={viewer(["sublets:handle"])} />);

    await screen.findByText("Ansökningar om andrahandsupplåtelse");
    // The seeded row is open, so the consent and refusal controls are there and
    // the tribunal one is not.
    expect(
      screen.getByRole("button", { name: /^Samtyck till upplåtelsen/ }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /^Anteckna hyresnämndens beslut/ }),
    ).toBeNull();
  });

  it("refuses with the ground it wrote, and takes no note where none was written", async () => {
    // An empty box is no note rather than an empty one: the server's schema
    // takes a non-empty string or null.
    render(<SubletsScreen viewer={viewer(["sublets:handle"])} />);

    await screen.findByText("Ansökningar om andrahandsupplåtelse");
    await userEvent.click(
      screen.getByRole("button", { name: /^Vägra samtycke/ }),
    );

    expect(decideSubletApplication).toHaveBeenCalledWith({
      applicationId: "sublet-1",
      consent: false,
      note: null,
    });
  });

  it("records a tribunal permission without turning a refusal into a consent", async () => {
    /*
     * The load-bearing assertion of this file. The association did not consent;
     * the tribunal permitted. A screen that showed "Samtycke givet" after this
     * would be putting words in the board's mouth, and the member would read
     * that the association had agreed to something it refused.
     */
    fetchSubletQueue.mockResolvedValue({
      ok: true,
      value: {
        applications: [
          {
            ...REFUSED_APPLICATION,
            applicant: APPLICANT,
            closedByPersonId: "person-bea",
          },
        ],
      },
    });

    render(<SubletsScreen viewer={viewer(["sublets:handle"])} />);

    await screen.findByText("Ansökningar om andrahandsupplåtelse");
    await userEvent.click(
      screen.getByRole("button", { name: /^Anteckna hyresnämndens beslut/ }),
    );

    await userEvent.type(
      screen.getByLabelText("Tillstånd från och med"),
      "2028-12-15",
    );
    await userEvent.type(screen.getByLabelText("Till och med"), "2029-08-31");
    await userEvent.click(screen.getByRole("button", { name: "Spara" }));

    expect(recordSubletTribunalPermission).toHaveBeenCalledWith({
      applicationId: "sublet-2",
      permission: { permittedOn: "2028-12-15", permittedUntil: "2029-08-31" },
    });
    // And the row still says the association refused.
    expect(screen.getAllByText("Nekad").length).toBeGreaterThan(0);
    expect(screen.queryByText("Samtycke givet")).toBeNull();
  });
});
