import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_ROUTE = "openbrf:public-route";

/**
 * Marks a route as reachable without a session.
 *
 * The authorization guard is registered globally, so every route requires
 * authentication unless it opts out here. That direction is deliberate:
 * forgetting this decorator makes a route inaccessible, while the opposite
 * default would make a forgotten guard silently expose the register.
 *
 * Only three kinds of route belong here: the sign-in surface itself, the
 * liveness probe, and the two token-bearing flows (invitation acceptance and
 * self-signup) that a person by definition cannot be signed in for.
 */
export function Public(): MethodDecorator & ClassDecorator {
  return SetMetadata(IS_PUBLIC_ROUTE, true);
}
