import { describe, expect, it, vi } from "vite-plus/test";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { IssueChargeBasis, IssueService } from "../issues/issue.service";
import { MemberChargesController } from "./member-charges.controller";
import type { MemberChargeService } from "./member-charge.service";

/**
 * The charge read for an issue is two reads, the party and the charges, and a
 * reporter's protection can change between them. The charge form is prefilled
 * from the party, so the answer has to agree with the charges it comes with.
 */

const ISSUE_ID = "issue-1";
const READER = "reader-1";
const request = { principal: { personId: READER } } as RequestWithPrincipal;

function basis(party: IssueChargeBasis["party"]): IssueChargeBasis {
  return { issueId: ISSUE_ID, party } as IssueChargeBasis;
}

function controller(
  bases: IssueChargeBasis[],
  charges: unknown,
): { subject: MemberChargesController; reads: ReturnType<typeof vi.fn> } {
  const reads = vi.fn();
  for (const next of bases) {
    reads.mockResolvedValueOnce(next);
  }
  const subject = new MemberChargesController(
    {
      listForIssue: () => Promise.resolve(charges),
    } as unknown as MemberChargeService,
    { chargeBasis: reads } as unknown as IssueService,
  );
  return { subject, reads };
}

describe("the charges of an issue", () => {
  it("reads the party again when the protection was cleared between the two reads", async () => {
    const person = { kind: "person", personId: "p-1" } as never;
    const { subject, reads } = controller([basis(null), basis(person)], []);

    const answer = await subject.forIssue(ISSUE_ID, request);

    expect(reads).toHaveBeenCalledTimes(2);
    expect(answer.issue.party).toEqual(person);
    expect(answer.charges).toEqual([]);
  });

  it("withholds the person party with the charges when the protection was set between the two reads", async () => {
    const person = { kind: "person", personId: "p-1" } as never;
    const { subject, reads } = controller([basis(person)], null);

    const answer = await subject.forIssue(ISSUE_ID, request);

    expect(reads).toHaveBeenCalledTimes(1);
    expect(answer.issue.party).toBeNull();
    expect(answer.charges).toBeNull();
  });

  it("keeps an apartment party when the charges are withheld", async () => {
    const apartment = { kind: "apartment", apartmentId: "a-1" } as never;
    const { subject } = controller([basis(apartment)], null);

    const answer = await subject.forIssue(ISSUE_ID, request);

    expect(answer.issue.party).toEqual(apartment);
  });
});
