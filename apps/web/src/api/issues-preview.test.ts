import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { fetchReportableTypes, type ReportableIssueType } from "./issues";
import { forgetResidentPreview, setResidentPreview } from "./viewer-preview";

/**
 * The issue types the report form is offered while the resident preview is on
 * (ADR 0049). The server offers whoever handles issues the board's internal
 * types besides their own, and an account that does not live here the
 * public's (`issue-reporter-groups.ts`); a resident is offered only the types
 * residents may report, so the preview keeps those and nothing else.
 */

const request = vi.fn();

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  apiRequest: (method: string, path: string) => request(method, path),
}));

/** The types the server offers a board member who lives here and handles issues. */
const AS_THE_BOARD_IS_OFFERED_THEM: ReportableIssueType[] = [
  {
    id: "type-lift",
    name: "Hissen",
    reporters: ["PUBLIC", "RESIDENTS"],
    ringFenced: false,
    textRetentionYears: 2,
  },
  {
    id: "type-budget",
    name: "Budgetuppföljning",
    reporters: ["HANDLERS"],
    ringFenced: false,
    textRetentionYears: 2,
  },
  {
    id: "type-laundry",
    name: "Tvättstugan",
    reporters: ["RESIDENTS", "HANDLERS"],
    ringFenced: false,
    textRetentionYears: 2,
  },
  {
    id: "type-gate",
    name: "Grinden",
    reporters: ["PUBLIC", "HANDLERS"],
    ringFenced: false,
    textRetentionYears: 2,
  },
];

beforeEach(() => {
  request.mockReset().mockResolvedValue({
    ok: true,
    value: AS_THE_BOARD_IS_OFFERED_THEM,
  });
});

afterEach(() => {
  forgetResidentPreview();
  sessionStorage.clear();
});

describe("the issue types the report form is offered", () => {
  it("are the server's own while the preview is off", async () => {
    expect(await fetchReportableTypes()).toEqual({
      ok: true,
      value: AS_THE_BOARD_IS_OFFERED_THEM,
    });
  });

  it("keep only the types residents may report while it is on", async () => {
    // The budget type is the board's own and the gate is offered to the
    // public and the handlers: the server offers both to this account because
    // it handles issues, and neither to a resident.
    setResidentPreview(true);

    const result = await fetchReportableTypes();
    expect(result.ok && result.value.map((type) => type.id)).toEqual([
      "type-lift",
      "type-laundry",
    ]);
  });

  it("are the server's own again once the preview is stopped", async () => {
    setResidentPreview(true);
    setResidentPreview(false);

    expect(await fetchReportableTypes()).toEqual({
      ok: true,
      value: AS_THE_BOARD_IS_OFFERED_THEM,
    });
  });
});
