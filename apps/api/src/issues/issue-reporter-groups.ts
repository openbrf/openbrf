import type { IssueReporterGroup } from "@openbrf/shared";

import type { Principal } from "../authorization/capabilities";

/**
 * Which groups of reporters a principal reports as.
 *
 * An issue type carries the set of groups that may report it (ADR 0054), and
 * a principal is offered a type when the two overlap. This is the whole rule,
 * written once as a pure function so it can be asserted directly and so every
 * surface that offers a type list - the application's report form and the
 * website's public form - reaches the same answer. It is applied on the SERVER
 * for every caller. A client-side filter would be a second opinion that could
 * disagree, and the thing it would disagree about is which of the association's
 * internal categories a resident is shown.
 *
 * Four rules, and each one has a reason:
 *
 *   - Nobody signed in reports as the public. That is the website form's
 *     group: a neighbour, a passer-by, a contractor at the door.
 *   - A signed-in person who lives in the house reports as a resident.
 *     Residency rather than membership decides it, because a partner or a
 *     tenant reports the same broken lift as the tenant-owner does, and the
 *     group names who is reporting rather than who holds the apartment.
 *   - A signed-in person who does NOT live in the house - an external board
 *     member, an administrator - reports as the public, because that is what
 *     they are to the building.
 *   - Whoever handles issues additionally reports as a handler, which is what
 *     offers them the board's own internal types. Those are not offered to
 *     anybody else, ever: an internal category is the association's own note
 *     to itself.
 */
export function reporterGroupsOf(
  principal: Principal | null,
): readonly IssueReporterGroup[] {
  if (principal === null) {
    return ["PUBLIC"];
  }

  const groups: IssueReporterGroup[] = [
    principal.isResident ? "RESIDENTS" : "PUBLIC",
  ];

  if (principal.capabilities.has("issues:handle")) {
    groups.push("HANDLERS");
  }

  return groups;
}
