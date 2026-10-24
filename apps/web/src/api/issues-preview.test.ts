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
 * types besides their own (`issue-audience.ts`); a resident is never offered
 * them, so the preview leaves them out.
 */

const request = vi.fn();

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  apiRequest: (method: string, path: string) => request(method, path),
}));

/** The types the server offers a board member who lives here and handles issues. */
const AS_THE_BOARD_IS_OFFERED_THEM: ReportableIssueType[] = [
  { id: "type-lift", name: "Hissen", audience: "MEMBER" },
  { id: "type-budget", name: "Budgetuppföljning", audience: "BOARD" },
  { id: "type-laundry", name: "Tvättstugan", audience: "MEMBER" },
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

  it("leave out the board's internal types while it is on", async () => {
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
