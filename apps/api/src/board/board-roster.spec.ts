import { describe, expect, it } from "vitest";

import type { ConsentDates } from "../address-book/publication-consent";
import { type BoardSeat, publishableRoster } from "./board-roster";

/**
 * Who may be named on the association's own website.
 *
 * The highest-stakes rule this module has, and it is asserted here rather than
 * through a rendered page because the cases that matter are combinations of
 * dated facts: a consent granted and withdrawn, withdrawn and granted again,
 * never asked for at all, and a person the association is not allowed to
 * publish whatever they said. A test that needed a database to reach those
 * would not reach all of them.
 */

const DAY = 24 * 60 * 60 * 1000;
const JANUARY = new Date("2026-01-15T09:00:00Z");
const MARCH = new Date(JANUARY.getTime() + 60 * DAY);
const JUNE = new Date(JANUARY.getTime() + 150 * DAY);

/** A consent granted on a date and standing since. */
function granted(on: Date): ConsentDates {
  return { scope: "BOARD_ROSTER", grantedAt: on, withdrawnAt: null };
}

/** A consent granted on a date and closed on a later one. */
function withdrawn(on: Date, closed: Date): ConsentDates {
  return { scope: "BOARD_ROSTER", grantedAt: on, withdrawnAt: closed };
}

function seat(overrides: Partial<BoardSeat> = {}): BoardSeat {
  return {
    position: "BOARD_MEMBER",
    firstName: "Anna",
    lastName: "Andersson",
    protectedPersonalData: false,
    consents: [granted(JANUARY)],
    ...overrides,
  };
}

describe("the published board roster", () => {
  it("names somebody who has consented to exactly this", () => {
    expect(publishableRoster([seat()])).toEqual([
      { position: "BOARD_MEMBER", name: "Anna Andersson" },
    ]);
  });

  it("leaves out somebody nobody has asked", () => {
    // Never asked and withdrawn are two different conversations for the board
    // to have. To a page they are one answer: this name is not published.
    expect(publishableRoster([seat({ consents: [] })])).toEqual([]);
  });

  it("leaves out somebody whose consent has been withdrawn", () => {
    expect(
      publishableRoster([seat({ consents: [withdrawn(JANUARY, MARCH)] })]),
    ).toEqual([]);
  });

  it("names somebody who withdrew and then consented again", () => {
    // Three dated facts on one person, and the most recent grant is the state
    // that holds. The older row stays as the record of what was lawful to
    // publish when, and it must not be what decides today's page.
    expect(
      publishableRoster([
        seat({ consents: [withdrawn(JANUARY, MARCH), granted(JUNE)] }),
      ]),
    ).toEqual([{ position: "BOARD_MEMBER", name: "Anna Andersson" }]);
  });

  it("leaves out somebody who consented and then withdrew, whatever the order of the rows", () => {
    expect(
      publishableRoster([
        seat({ consents: [withdrawn(JUNE, JUNE), granted(JANUARY)] }),
      ]),
    ).toEqual([]);
  });

  it("ignores a consent given for another scope", () => {
    // One consent covers one scope. Agreeing to a photograph is not agreeing
    // to be named in the roster.
    expect(
      publishableRoster([
        seat({
          consents: [
            { scope: "PHOTO", grantedAt: JANUARY, withdrawnAt: null },
            { scope: "NAME_ON_SITE", grantedAt: JANUARY, withdrawnAt: null },
          ],
        }),
      ]),
    ).toEqual([]);
  });

  it("never names a person with protected personal data, consent or not", () => {
    // Publication is what protection exists to prevent, so the association
    // carries this rule rather than the person carrying it.
    expect(
      publishableRoster([
        seat({ protectedPersonalData: true, consents: [granted(JANUARY)] }),
      ]),
    ).toEqual([]);
  });

  it("publishes a name and a position and nothing else", () => {
    const [entry] = publishableRoster([seat()]);

    expect(Object.keys(entry ?? {}).sort()).toEqual(["name", "position"]);
  });

  it("reads in seniority and then by name", () => {
    const roster = publishableRoster([
      seat({
        position: "DEPUTY_BOARD_MEMBER",
        firstName: "Bo",
        lastName: "Ek",
      }),
      seat({ position: "BOARD_MEMBER", firstName: "Cecilia", lastName: "Ö" }),
      seat({ position: "BOARD_MEMBER", firstName: "Dan", lastName: "Ahl" }),
      seat({ position: "CHAIR", firstName: "Eva", lastName: "Lind" }),
    ]);

    expect(roster.map((entry) => entry.name)).toEqual([
      "Eva Lind",
      "Dan Ahl",
      "Cecilia Ö",
      "Bo Ek",
    ]);
  });

  it("names somebody holding two seats under each of them", () => {
    // The register's own answer, and the roster does not improve on it:
    // collapsing the two would be this module deciding which the association
    // meant.
    const roster = publishableRoster([
      seat({ position: "CHAIR" }),
      seat({ position: "BOARD_MEMBER" }),
    ]);

    expect(roster).toEqual([
      { position: "CHAIR", name: "Anna Andersson" },
      { position: "BOARD_MEMBER", name: "Anna Andersson" },
    ]);
  });
});
