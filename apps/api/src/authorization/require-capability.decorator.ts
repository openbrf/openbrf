import { SetMetadata } from "@nestjs/common";

import type { Capability } from "./capabilities";

export const REQUIRED_CAPABILITIES = "openbrf:required-capabilities";

/**
 * Declares the capabilities a route requires. Several are combined with AND.
 *
 * Applied to a controller it covers every route in it, which is the safer
 * default: a new route added later inherits the restriction instead of being
 * accidentally open.
 */
export function RequireCapability(
  ...capabilities: Capability[]
): MethodDecorator & ClassDecorator {
  return SetMetadata(REQUIRED_CAPABILITIES, capabilities);
}
