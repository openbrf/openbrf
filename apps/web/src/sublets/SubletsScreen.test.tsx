import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import "../i18n";
import type { Viewer } from "../api/instance";
import type { OwnSubletApplication } from "../api/sublets";
import { SubletsScreen } from "./SubletsScreen";

/**
 * What the house's subletting page gives a seat.
 *
 * The API refuses every call whatever the browser was shown, so hiding a panel
 * is courtesy. What is not courtesy is the read behind it: the board's queue is
 * the one place an application says which member wants to let their flat and
 * why, and a page that asked for it on a member's behalf would be asking the
 * server for other people's data with nowhere to put it. The queue is the
 * board's page now (ADR 0049), so this file asserts that the house's page never
 * makes the request, for a board member as much as for anybody.
 *
 * Who is offered the form is a statute rather than a product decision.
 * `sublets:apply` is derived from membership under BRL 7 kap. 10 § första
 * stycket, which lets a bostadsrättshavare let *sin lägenhet* in andra hand
 * with the board's consent, so a resident who holds no tenant-ownership is
 * offered no form.
 */

const fetchSubletIntake = vi.fn();
const fetchSubletQueue = vi.fn();
const withdrawSubletApplication = vi.fn();
const reviseSubletApplication = vi.fn();

vi.mock("../api/sublets", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/sublets")>()),
  fetchSubletIntake: () => fetchSubletIntake(),
  fetchSubletQueue: () => fetchSubletQueue(),
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

  it("is told they withdrew an application, not that the board answered it", async () => {
    // The row is kept for years, so it must say who closed it.
    fetchSubletIntake.mockResolvedValue({
      ok: true,
      value: {
        apartments: [APARTMENT],
        applications: [
          {
            ...OPEN_APPLICATION,
            status: "WITHDRAWN",
            closedAt: "2028-11-05T12:00:00.000Z",
          },
        ],
      },
    });

    render(<SubletsScreen viewer={viewer(["sublets:apply"])} />);

    await screen.findByText("Dina ansökningar");
    expect(screen.getByText("Du återkallade den 2028-11-05.")).not.toBeNull();
    expect(screen.queryByText(/Styrelsen svarade/u)).toBeNull();
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

/**
 * One page, one audience: a board member who is also a member applies from
 * here like anybody else, and decides the requests on the board's own page
 * (ADR 0049).
 */
describe("a board member who is also a member", () => {
  it("shows no board content to a board member", async () => {
    render(
      <SubletsScreen viewer={viewer(["sublets:apply", "sublets:handle"])} />,
    );

    await screen.findByText("Begär styrelsens samtycke");
    expect(screen.getByText("Dina ansökningar")).not.toBeNull();
    expect(
      screen.queryByText("Ansökningar om andrahandsupplåtelse"),
    ).toBeNull();
    expect(screen.queryByText("Styrelsen")).toBeNull();
    expect(fetchSubletQueue).not.toHaveBeenCalled();
  });
});
