import type { PrismaService } from "../database/prisma.service";

/**
 * A granted erasure request, recorded as the board would decide it, for the
 * integration suites that drive a purge on one.
 *
 * Written directly rather than through the decision endpoint: what these suites
 * test is what a purge does with a request that stands, and the decision's own
 * rules are `data-subject-request.int-spec.ts`. A suite removes the row itself
 * before it removes the person, because the request keeps its person.
 */
export async function grantErasure(
  prisma: PrismaService,
  personId: string,
  decidedByPersonId: string,
  on: Date = new Date(),
): Promise<{ id: string }> {
  return prisma.dataSubjectRequest.create({
    data: {
      personId,
      kind: "ERASURE",
      requestedOn: on,
      ground: "Jag vill inte finnas kvar hos foreningen.",
      erasureGround: "NO_LONGER_NECESSARY",
      decision: "GRANTED",
      erasureException: "NONE",
      decisionGround: "Inget lagligt krav hindrar radering.",
      decidedAt: on,
      recordedByPersonId: decidedByPersonId,
      decidedByPersonId,
    },
    select: { id: true },
  });
}
