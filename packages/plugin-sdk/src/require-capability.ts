/**
 * Raising a plugin route above the capability floor the host gives it.
 *
 * The host reads one metadata key off a controller and off each of its routes,
 * and answers a request only for a person who holds every capability listed
 * there. A plugin's controllers get a floor from the plugin's own permissions
 * (see "Routes" in the plugin contract); `RequireCapability` is how a route
 * asks for more.
 *
 * Written without `@nestjs/common` on purpose, for the reason `definePlugin` is
 * an identity function: the SDK is bundled into the plugin, and an import of
 * its own would have to be resolved from the data volume. NestJS's
 * `SetMetadata` does no more than this, on the same global `Reflect` the host's
 * copy of NestJS writes to.
 */

/** The metadata key the host reads a route's or a controller's capabilities from. */
export const REQUIRED_CAPABILITIES_KEY = "openbrf:required-capabilities";

/**
 * Every capability name the host knows, which is what a route may require.
 *
 * Listed here, not derived, because the SDK cannot import the host. The host
 * checks the list against its own capabilities in a test, so a capability
 * added there is not missing here for long; until the SDK is released with it,
 * a plugin that needs the new name is a type error rather than a typo caught
 * at request time.
 */
export const PLUGIN_ROUTE_CAPABILITIES = [
  "association:manage",
  "association:read",
  "addressBook:read",
  "addressBook:write",
  "memberRegister:read",
  "apartmentRegister:read",
  "protectedData:reveal",
  "registerReport:export",
  "invitation:send",
  "signupRequest:decide",
  "self:manage",
  "residentDirectory:read",
  "issues:handle",
  "issues:report",
  "issues:configure",
  "documents:manage",
  "site:manage",
  "news:comment",
  "boardPosition:manage",
  "bookings:book",
  "bookings:manage",
  "bookings:configure",
  "events:manage",
  "events:attend",
  "systemRole:manage",
  "motions:submit",
  "motions:handle",
  "meetings:manage",
  "memberCharges:manage",
  "fees:manage",
  "dataProtection:manage",
  "boardMailbox:handle",
  "sublets:apply",
  "sublets:handle",
  "keyOrders:place",
  "keyOrders:handle",
  "chat:participate",
  "chat:moderate",
  "apartmentBinder:manage",
] as const;

/** A capability name a plugin route may require. */
export type PluginRouteCapability = (typeof PLUGIN_ROUTE_CAPABILITIES)[number];

/** The slice of `Reflect` that `reflect-metadata` adds, which NestJS loads. */
interface MetadataReflect {
  defineMetadata?: (key: string, value: unknown, target: object) => void;
}

/**
 * Declares the capabilities a route requires. Several are combined with AND.
 *
 * Applied to a controller it covers every route in it. It can only add to the
 * floor the host gives the plugin: a route cannot require less.
 */
export function RequireCapability(
  ...capabilities: PluginRouteCapability[]
): MethodDecorator & ClassDecorator {
  return ((
    target: object,
    _key?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    const define = (Reflect as unknown as MetadataReflect).defineMetadata;
    if (define === undefined) {
      throw new Error(
        "RequireCapability needs reflect-metadata, which @nestjs/common loads: import it before the controller.",
      );
    }
    if (descriptor !== undefined) {
      define(REQUIRED_CAPABILITIES_KEY, capabilities, descriptor.value);
      return descriptor;
    }
    define(REQUIRED_CAPABILITIES_KEY, capabilities, target);
    return target;
  }) as MethodDecorator & ClassDecorator;
}
