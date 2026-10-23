import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import type { OwnSubletApplication } from "../api/sublets";
import { SubletQueueScreen } from "./SubletQueueScreen";

/**
 * The board's page for subletting: the applications waiting for its consent,
 * and what it records about them.
 *
 * The API refuses every call whatever the browser was shown, so hiding the
 * page is courtesy. What is not courtesy is the read behind it: the queue is
 * the one place an application says which member wants to let their flat and
 * why, and a page that asked for it on a member's behalf would be asking the
 * server for other people's data with nowhere to put it. So this file asserts
 * the request as well as the panel.
 *
 * `sublets:handle` is the board's, because BRL 7 kap. 10 § names the styrelse
 * as who gives the consent. A board member who is also a member applies from
 * the house's page (ADR 0049), so this page offers no form to anybody.
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
const recordSubletLettingEnd = vi.fn();

vi.mock("../api/sublets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/sublets")>()),
  fetchSubletIntake: () => fetchSubletIntake(),
  fetchSubletQueue: () => fetchSubletQueue(),
  decideSubletApplication: (input: unknown) => decideSubletApplication(input),
  recordSubletTribunalPermission: (input: unknown) =>
    recordSubletTribunalPermission(input),
  recordSubletLettingEnd: (input: unknown) => recordSubletLettingEnd(input),
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
  lettingEndedOn: null,
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

/** A consent whose letting the board may record as having ended early. */
const CONSENTED_APPLICATION: OwnSubletApplication = {
  ...OPEN_APPLICATION,
  id: "sublet-3",
  status: "CONSENTED",
  closedAt: "2028-11-20T12:00:00.000Z",
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
  recordSubletLettingEnd.mockReset().mockResolvedValue({
    ok: true,
    value: {
      ...CONSENTED_APPLICATION,
      lettingEndedOn: "2029-05-15",
      applicant: APPLICANT,
      closedByPersonId: "person-bea",
    },
  });
});

describe("the board", () => {
  it("is given the page under the board's sign", async () => {
    render(<SubletQueueScreen viewer={viewer(["sublets:handle"])} />);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Styrelsen Pröva ansökningar",
      }),
    ).not.toBeNull();
    expect(
      screen.getByText("Det här ser bara styrelsen och administratören."),
    ).not.toBeNull();
    await screen.findByText("Ansökningar om andrahandsupplåtelse");
  });
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

    render(<SubletQueueScreen viewer={viewer(["sublets:handle"])} />);

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

    render(<SubletQueueScreen viewer={viewer(["sublets:handle"])} />);

    await screen.findByText(
      "Ansökningarna om andrahandsupplåtelse kunde inte läsas just nu.",
    );
    expect(
      screen.queryByText("Ansökningar om andrahandsupplåtelse"),
    ).toBeNull();
    expect(screen.queryByText("Ingen medlem har begärt samtycke.")).toBeNull();
  });

  it("is offered the queue and no form, whether or not it holds a tenant-ownership", async () => {
    // The consent is the board's to give and the application is the member's
    // to make. A board member who is also a member applies from the house's
    // page like anybody else, so this page neither offers the form nor reads
    // what it would need.
    render(
      <SubletQueueScreen
        viewer={viewer(["sublets:apply", "sublets:handle"])}
      />,
    );

    await screen.findByText("Ansökningar om andrahandsupplåtelse");
    expect(screen.queryByText("Begär styrelsens samtycke")).toBeNull();
    expect(screen.queryByText("Dina ansökningar")).toBeNull();
    expect(fetchSubletIntake).not.toHaveBeenCalled();
  });

  it("is offered the rent tribunal record on a refused row and nowhere else", async () => {
    /*
     * The control exists on a refused row only, because 7 kap. 11 § opens that
     * route only from a refusal and the server refuses it anywhere else.
     * Offering it on an open row would be a control that could only fail.
     */
    render(<SubletQueueScreen viewer={viewer(["sublets:handle"])} />);

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
    render(<SubletQueueScreen viewer={viewer(["sublets:handle"])} />);

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

    render(<SubletQueueScreen viewer={viewer(["sublets:handle"])} />);

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

  it("records the day a consented letting ended, inside the period consented to", async () => {
    /*
     * Until the board records it, a consent is kept for as long as its period
     * runs and a granted erasure request waits for it. The control is on a
     * consented row only, and the day picker is held to the period.
     */
    fetchSubletQueue.mockResolvedValue({
      ok: true,
      value: {
        applications: [
          {
            ...CONSENTED_APPLICATION,
            applicant: APPLICANT,
            closedByPersonId: "person-bea",
          },
          {
            ...REFUSED_APPLICATION,
            applicant: APPLICANT,
            closedByPersonId: "person-bea",
          },
        ],
      },
    });

    render(<SubletQueueScreen viewer={viewer(["sublets:handle"])} />);

    await screen.findByText("Ansökningar om andrahandsupplåtelse");
    expect(
      screen.getAllByRole("button", {
        name: /^Anteckna sista dagen för upplåtelsen från/,
      }),
    ).toHaveLength(1);
    await userEvent.click(
      screen.getByRole("button", {
        name: /^Anteckna sista dagen för upplåtelsen från/,
      }),
    );

    const day = screen.getByLabelText("Upplåtelsens sista dag");
    expect(day.getAttribute("min")).toBe("2029-02-01");
    expect(day.getAttribute("max")).toBe("2029-08-31");
    await userEvent.type(day, "2029-05-15");
    await userEvent.click(screen.getByRole("button", { name: "Spara" }));

    expect(recordSubletLettingEnd).toHaveBeenCalledWith({
      applicationId: "sublet-3",
      lettingEndedOn: "2029-05-15",
    });
  });
});

describe("a member who is not on the board", () => {
  it("is told the page is the board's, under no sign, and nothing is read", async () => {
    render(<SubletQueueScreen viewer={viewer(["sublets:apply"])} />);

    await screen.findByText(
      "Den här sidan är styrelsens. Ditt konto har inget att göra här.",
    );
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.queryByText("Styrelsen")).toBeNull();
    expect(
      screen.queryByText("Ansökningar om andrahandsupplåtelse"),
    ).toBeNull();
    expect(fetchSubletQueue).not.toHaveBeenCalled();
    expect(fetchSubletIntake).not.toHaveBeenCalled();
  });
});
