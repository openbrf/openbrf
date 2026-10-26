import type {
  ExtensionContext,
  ExtensionContributionDefinition,
  ExtensionTarget,
  PluginAddress,
  PluginHost,
} from "@openbrf/plugin-sdk";

/**
 * The host as the addon sees it, holding only what the addon uses: its
 * addresses, its logger and `extensions.contribute`, which keeps what the
 * addon contributed for the test to call as digital signage would through the
 * host. Everything else refuses, as the host refuses a permission the addon
 * did not ask for.
 */
export interface FakeHost {
  host: PluginHost;
  addresses: PluginAddress[];
  addressReads: number;
  logged: string[];
  contributed: {
    target: ExtensionTarget;
    contribution: ExtensionContributionDefinition;
  }[];
}

export const STORGATAN_3: PluginAddress = {
  id: "address-storgatan-3",
  street: "Storgatan",
  number: "3",
};

export function fakeHost(options: { withExtensions?: boolean } = {}): FakeHost {
  const state: FakeHost = {
    host: undefined as unknown as PluginHost,
    addresses: [STORGATAN_3],
    addressReads: 0,
    logged: [],
    contributed: [],
  };
  const known = {
    permissions: ["addresses:read"],
    logger: {
      log: (message: string) => state.logged.push(message),
      warn: (message: string) => state.logged.push(message),
      error: (message: string) => state.logged.push(message),
      debug: () => undefined,
    },
    addresses: {
      list: async () => {
        state.addressReads += 1;
        return state.addresses;
      },
    },
    ...(options.withExtensions === false
      ? {}
      : {
          extensions: {
            contribute: (
              target: ExtensionTarget,
              contribution: ExtensionContributionDefinition,
            ) => state.contributed.push({ target, contribution }),
          },
        }),
  };
  state.host = new Proxy(known, {
    get(target, property) {
      if (property in target) {
        return Reflect.get(target, property);
      }
      if (property === "extensions" || typeof property === "symbol") {
        return undefined;
      }
      throw new Error(`The addon reached host.${property}, which it must not.`);
    },
  }) as unknown as PluginHost;
  return state;
}

export function context(
  signal = new AbortController().signal,
): ExtensionContext {
  return {
    hostPlugin: "signage",
    point: "source",
    version: 1,
    requestId: "request-1",
    now: new Date("2026-12-01T09:00:00Z"),
    signal,
  };
}
