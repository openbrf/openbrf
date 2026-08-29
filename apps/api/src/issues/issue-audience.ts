import type { IssueAudience } from "../generated/prisma/enums";
import type { Principal } from "../authorization/capabilities";

/**
 * Which audiences' issue types a principal may report under.
 *
 * This is the whole audience rule, written once as a pure function so it can be
 * asserted directly and so every surface that offers a type list - the
 * application's report form today, the website's public form later - reaches
 * the same answer. It is applied on the SERVER for every caller. A client-side
 * filter would be a second opinion that could disagree, and the thing it would
 * disagree about is which of the association's internal categories a resident
 * is shown.
 *
 * Three rules, and each one has a reason:
 *
 *   - Nobody signed in is a non-member. That is the public form's audience: a
 *     neighbour, a passer-by, a contractor at the door.
 *   - A signed-in person who lives in the house reports as a member. Residency
 *     rather than membership decides it, because a partner or a tenant reports
 *     the same broken lift as the tenant-owner does, and the audience names who
 *     is reporting rather than who holds the apartment.
 *   - A signed-in person who does NOT live in the house - an external board
 *     member, an administrator - is offered the non-member types, because that
 *     is what they are to the building.
 *   - Whoever handles issues additionally gets the board's own internal types.
 *     They are not offered to anybody else, ever: an internal category is the
 *     association's own note to itself.
 */
export function reportableAudiences(
  principal: Principal | null,
): readonly IssueAudience[] {
  if (principal === null) {
    return ["NON_MEMBER"];
  }

  const audiences: IssueAudience[] = [
    principal.isResident ? "MEMBER" : "NON_MEMBER",
  ];

  if (principal.capabilities.has("issues:handle")) {
    audiences.push("BOARD");
  }

  return audiences;
}
