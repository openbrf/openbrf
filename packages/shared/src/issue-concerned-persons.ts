/**
 * The most people a handler may record as concerned by one issue (ADR 0057).
 *
 * A case about a disturbance is about a household or two, and one about a
 * leak about the flats it reached. The bound is there so the list stays one a
 * handler reads at a glance, and so the record cannot be made a roll of the
 * house: the resident picker answers one apartment at a time, and this keeps
 * an issue from collecting all of them. Both applications read it, the server
 * to refuse one more and the screen to stop offering it.
 */
export const ISSUE_CONCERNED_PERSON_LIMIT = 10;
