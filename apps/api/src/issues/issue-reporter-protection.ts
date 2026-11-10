import type { Prisma } from "../generated/prisma/client";

/**
 * Of these issues, the ones a person with protected personal data reported,
 * by that person's protection as it stands now.
 *
 * The issue queue withholds such a reporter's name, identifier and apartment
 * from every handler, the board included (`IssueService.reporterOf`). Whatever
 * else reads an issue next to a named person or apartment - a charge made from
 * the issue, today - asks this, so that it cannot pair the report with the
 * identity the queue withholds. Asked on every read rather than when the link
 * was made: protection is often recorded after the report, and a link made
 * while the reporter was unprotected is withheld from then on.
 *
 * `reporterPersonId` is a plain column rather than a relation (see the
 * schema), so the reporters are read in a second query rather than joined. An
 * issue that is gone, or that nobody in the register reported, has no
 * protected reporter.
 *
 * `exceptReporterId` leaves out the issues that person reported. The withholding
 * keeps a report from being paired with an identity the reader may not learn;
 * the reporter's own copy of what the association holds about them (the access
 * report, GDPR art. 15) pairs their report with themselves.
 */
export async function issuesReportedByProtectedPersons(
  client: Pick<Prisma.TransactionClient, "issue" | "person">,
  issueIds: readonly string[],
  exceptReporterId?: string,
): Promise<ReadonlySet<string>> {
  const ids = [...new Set(issueIds)];
  if (ids.length === 0) {
    return new Set();
  }
  const issues = await client.issue.findMany({
    where: { id: { in: ids }, reporterPersonId: { not: null } },
    select: { id: true, reporterPersonId: true },
  });
  const reporterIds = [
    ...new Set(
      issues
        .map((issue) => issue.reporterPersonId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (reporterIds.length === 0) {
    return new Set();
  }
  const protectedReporters = await client.person.findMany({
    where: { id: { in: reporterIds }, protectedPersonalData: true },
    select: { id: true },
  });
  const protectedIds = new Set(protectedReporters.map((person) => person.id));
  return new Set(
    issues
      .filter(
        (issue) =>
          issue.reporterPersonId !== null &&
          issue.reporterPersonId !== exceptReporterId &&
          protectedIds.has(issue.reporterPersonId),
      )
      .map((issue) => issue.id),
  );
}
