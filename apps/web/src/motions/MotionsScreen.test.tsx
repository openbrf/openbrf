import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../i18n";
import type { Viewer } from "../api/instance";
import type { OwnMotion } from "../api/motions";
import { MotionsScreen } from "./MotionsScreen";

/**
 * Which half of the motions screen a seat is given.
 *
 * The API refuses every call whatever the browser was shown, so hiding a panel is
 * courtesy. What is not courtesy is the read behind it: the board's queue is the
 * one place a motion says which member proposed what, and a screen that asked for
 * it on a member's behalf would be asking the server for other people's data on a
 * page that has nowhere to put it. So this file asserts the request as well as the
 * panel.
 *
 * The split is a statute rather than a product decision. `motions:submit` is
 * derived from membership under EFL 6 kap. 15 §, applied to a housing cooperative
 * by BRL 9 kap. 14 §, so a resident who holds no tenant-ownership is offered no
 * form; `motions:handle` is the board's, because a motion is addressed to it. A
 * board member who is not a member gets the queue and no form, which is the same
 * rule read from the other end and the case a screen written around "resident or
 * board" would get wrong.
 */

const fetchMotionIntake = vi.fn();
const fetchMotionQueue = vi.fn();
const acknowledgeMotion = vi.fn();
const withdrawMotion = vi.fn();

vi.mock("../api/motions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/motions")>()),
  fetchMotionIntake: () => fetchMotionIntake(),
  fetchMotionQueue: () => fetchMotionQueue(),
  acknowledgeMotion: (input: unknown) => acknowledgeMotion(input),
  withdrawMotion: (input: unknown) => withdrawMotion(input),
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

const OWN_MOTION = {
  id: "motion-1",
  title: "Laddstolpar i garaget",
  body: "Föreningen bör utreda vad laddstolpar skulle kosta.",
  status: "SUBMITTED" as const,
  submittedAt: "2027-01-20T09:00:00.000Z",
  closedAt: null,
};

const DEADLINE = { month: 1, day: 31, nextOn: "2027-01-31" };

beforeEach(() => {
  fetchMotionIntake.mockReset().mockResolvedValue({
    ok: true,
    value: { deadline: DEADLINE, motions: [OWN_MOTION] },
  });
  fetchMotionQueue.mockReset().mockResolvedValue({
    ok: true,
    value: {
      deadline: DEADLINE,
      motions: [
        {
          ...OWN_MOTION,
          submitter: {
            kind: "member",
            personId: "person-maja",
            name: "Maja Medlem",
          },
          closedByPersonId: null,
        },
      ],
    },
  });
  acknowledgeMotion.mockReset().mockResolvedValue({
    ok: true,
    value: {
      ...OWN_MOTION,
      status: "ACKNOWLEDGED",
      closedAt: "2027-02-01T09:00:00.000Z",
      submitter: {
        kind: "member",
        personId: "person-maja",
        name: "Maja Medlem",
      },
      closedByPersonId: "person-bea",
    },
  });
  withdrawMotion.mockReset().mockResolvedValue({
    ok: true,
    value: {
      ...OWN_MOTION,
      status: "WITHDRAWN",
      closedAt: "2027-02-01T09:00:00.000Z",
    },
  });
});

describe("a member", () => {
  it("is offered the form and their own motions, and never the queue", async () => {
    render(<MotionsScreen viewer={viewer(["motions:submit"])} />);

    await screen.findByText("Lämna in ett ärende till stämman");
    expect(screen.getByText("Dina motioner")).not.toBeNull();
    expect(screen.queryByText("Motioner från medlemmarna")).toBeNull();

    /*
     * And the read behind the panel was never issued. The queue says which member
     * proposed what, and a page with nowhere to put that must not ask for it -
     * asserting only the missing heading would pass while the request went out.
     */
    expect(fetchMotionQueue).not.toHaveBeenCalled();
    expect(fetchMotionIntake).toHaveBeenCalledTimes(1);
  });

  it("is told the bylaws' deadline, and that a later motion is still taken", async () => {
    // The deadline is the condition on reaching a particular meeting, not on the
    // association's ability to receive one. A form that showed the date without
    // saying so would leave a member believing a late item was on the agenda.
    render(<MotionsScreen viewer={viewer(["motions:submit"])} />);

    await screen.findByText("Lämna in ett ärende till stämman");
    expect(
      screen.getByText(/senast 2027-01-31.*tas ändå emot/s),
    ).not.toBeNull();
  });

  it("is told the bylaws set none rather than shown an invented date", async () => {
    fetchMotionIntake.mockResolvedValue({
      ok: true,
      value: { deadline: null, motions: [] },
    });

    render(<MotionsScreen viewer={viewer(["motions:submit"])} />);

    await screen.findByText("Lämna in ett ärende till stämman");
    expect(
      screen.getByText(/stadgar anger ingen tid för motioner/),
    ).not.toBeNull();
  });

  it("can withdraw an open motion, and is offered nothing on a closed one", async () => {
    fetchMotionIntake.mockResolvedValue({
      ok: true,
      value: {
        deadline: DEADLINE,
        motions: [
          OWN_MOTION,
          {
            ...OWN_MOTION,
            id: "motion-2",
            title: "Cykelställ på gaveln",
            status: "ACKNOWLEDGED" as const,
            closedAt: "2027-02-01T09:00:00.000Z",
          },
        ],
      },
    });

    render(<MotionsScreen viewer={viewer(["motions:submit"])} />);
    await screen.findByText("Dina motioner");

    // Offered on the open one, because that is the only state the API accepts.
    // A button on the closed one would always fail, which is a worse way to say
    // so than no button.
    expect(
      screen.getByRole("button", {
        name: "Återkalla motionen Laddstolpar i garaget",
      }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Återkalla motionen Cykelställ på gaveln",
      }),
    ).toBeNull();

    await userEvent.click(
      screen.getByRole("button", {
        name: "Återkalla motionen Laddstolpar i garaget",
      }),
    );
    await waitFor(() => {
      expect(withdrawMotion).toHaveBeenCalledWith({ motionId: "motion-1" });
    });
  });
});

describe("two acts whose answers cross", () => {
  it("keeps the newer read and drops the one it overtook", async () => {
    /*
     * Every act on this screen ends in a re-read, so two of them can be in
     * flight at once - a member withdraws one motion and then another before the
     * first answer is back. Both answers are well formed and the screen cannot
     * tell them apart by content, so the only rule available is that the newest
     * read wins. Applying whichever response happens to arrive last puts a
     * withdrawn motion back on the screen as open, with a control that would now
     * be refused.
     */
    const SECOND: OwnMotion = {
      ...OWN_MOTION,
      id: "motion-2",
      title: "Cykelställ på gaveln",
    };
    const withdrawn = (motion: OwnMotion): OwnMotion => ({
      ...motion,
      status: "WITHDRAWN",
      closedAt: "2027-02-01T09:00:00.000Z",
    });
    const intake = (
      motions: readonly OwnMotion[],
    ): { ok: true; value: unknown } => ({
      ok: true,
      value: { deadline: DEADLINE, motions },
    });

    // The read behind the first withdrawal, held open so the second one's answer
    // gets in front of it.
    let overtaken = (): void => undefined;
    const slow = new Promise((resolve) => {
      overtaken = () => {
        resolve(intake([withdrawn(OWN_MOTION), SECOND]));
      };
    });

    fetchMotionIntake
      .mockResolvedValueOnce(intake([OWN_MOTION, SECOND]))
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce(
        intake([withdrawn(OWN_MOTION), withdrawn(SECOND)]),
      );
    withdrawMotion.mockResolvedValue({ ok: true, value: withdrawn(SECOND) });

    render(<MotionsScreen viewer={viewer(["motions:submit"])} />);
    await screen.findByText("Dina motioner");

    const withdrawSecond = screen.getByRole("button", {
      name: `Återkalla motionen ${SECOND.title}`,
    });
    await userEvent.click(
      screen.getByRole("button", {
        name: `Återkalla motionen ${OWN_MOTION.title}`,
      }),
    );
    await userEvent.click(withdrawSecond);

    // Both reads have gone out and the second has been applied.
    await waitFor(() => {
      expect(fetchMotionIntake).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /^Återkalla motionen/ }),
      ).toBeNull();
    });

    // And now the read they overtook comes back.
    await act(async () => {
      overtaken();
      await slow;
    });

    expect(
      screen.queryByRole("button", {
        name: `Återkalla motionen ${SECOND.title}`,
      }),
    ).toBeNull();
  });
});

describe("the board", () => {
  it("is offered the queue, and no form without a tenant-ownership", async () => {
    /*
     * The case a screen written around "resident or board" gets wrong. A board
     * member who holds no tenant-ownership works the queue and has no right to
     * put an item into it: EFL 6 kap. 15 § attaches the right to the membership
     * and not to the office.
     */
    render(<MotionsScreen viewer={viewer(["motions:handle"])} />);

    await screen.findByText("Motioner från medlemmarna");
    expect(screen.queryByText("Lämna in ett ärende till stämman")).toBeNull();
    expect(screen.queryByText("Dina motioner")).toBeNull();
    expect(fetchMotionIntake).not.toHaveBeenCalled();
  });

  it("records a motion as received", async () => {
    render(<MotionsScreen viewer={viewer(["motions:handle"])} />);
    await screen.findByText("Motioner från medlemmarna");

    await userEvent.click(
      screen.getByRole("button", {
        name: "Anteckna motionen Laddstolpar i garaget som mottagen",
      }),
    );

    await waitFor(() => {
      expect(acknowledgeMotion).toHaveBeenCalledWith({ motionId: "motion-1" });
    });
  });

  it("is offered no way to reject a motion", async () => {
    // Refusing to take up a member's item is not the board's to decide under EFL
    // 6 kap. 15 §, and whether the meeting adopts the proposal is minuted at the
    // meeting. There is no endpoint for it and there must be no control either.
    render(<MotionsScreen viewer={viewer(["motions:handle"])} />);
    await screen.findByText("Motioner från medlemmarna");

    for (const label of [/avslå/i, /avvisa/i, /neka/i]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("does not name a member with protected personal data", async () => {
    // The board's own address book prints that name because a statutory register
    // has a reason to; a queue has none.
    fetchMotionQueue.mockResolvedValue({
      ok: true,
      value: {
        deadline: DEADLINE,
        motions: [
          {
            ...OWN_MOTION,
            submitter: { kind: "protected", personId: "person-maja" },
            closedByPersonId: null,
          },
        ],
      },
    });

    render(<MotionsScreen viewer={viewer(["motions:handle"])} />);
    await screen.findByText("Motioner från medlemmarna");

    expect(screen.queryByText("Maja Medlem")).toBeNull();
    expect(screen.getByText(/Skyddade personuppgifter/)).not.toBeNull();
  });
});

describe("a board member who is also a member", () => {
  it("gets both halves, and one deadline between them", async () => {
    // The ordinary case in a cooperative. Both reads happen and both carry the
    // bylaws clause, so the screen must not be able to show two different dates
    // for the same clause.
    render(
      <MotionsScreen viewer={viewer(["motions:submit", "motions:handle"])} />,
    );

    await screen.findByText("Motioner från medlemmarna");
    expect(screen.getByText("Lämna in ett ärende till stämman")).not.toBeNull();
    expect(screen.getByText("Dina motioner")).not.toBeNull();
    expect(screen.getAllByText(/2027-01-31/).length).toBe(2);
  });
});

describe("a resident who is not a member", () => {
  it("is offered neither half, and no read is issued", async () => {
    // A partner, an adult child or a tenant. They live here and hold no
    // tenant-ownership, so EFL 6 kap. 15 § gives them nothing here - and the
    // navigation does not offer this destination to them either.
    render(
      <MotionsScreen
        viewer={viewer(["self:manage", "residentDirectory:read"])}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Läser in motionerna...")).toBeNull();
    });
    expect(screen.queryByText("Lämna in ett ärende till stämman")).toBeNull();
    expect(screen.queryByText("Motioner från medlemmarna")).toBeNull();
    expect(fetchMotionIntake).not.toHaveBeenCalled();
    expect(fetchMotionQueue).not.toHaveBeenCalled();
  });
});
