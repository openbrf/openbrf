import type { PluginHost } from "@openbrf/plugin-sdk";

import { runServingRequest } from "../served-request";

/**
 * `host`, with each member that takes a request called in the work serving
 * that request, as a route's handler calls it (ADR 0051, update of
 * 2026-10-28). For tests of what a member does with a request it may use; a
 * test of the refusal calls the host itself.
 */
export function servingEach(host: PluginHost): PluginHost {
  const { actions, addressBook, audit, devices, themes } = host;
  return {
    ...host,
    actions: {
      ...actions,
      list: (request, filter) =>
        runServingRequest(request, () => actions.list(request, filter)),
      invoke: (request, name, input) =>
        runServingRequest(request, () => actions.invoke(request, name, input)),
      propose: (request, name, input) =>
        runServingRequest(request, () => actions.propose(request, name, input)),
      client: (request) =>
        runServingRequest(request, () => actions.client(request)),
    },
    addressBook: {
      ...addressBook,
      caller: (request) =>
        runServingRequest(request, () => addressBook.caller(request)),
    },
    audit: {
      record: (request, entry) =>
        request === null
          ? audit.record(request, entry)
          : runServingRequest(request, () => audit.record(request, entry)),
    },
    devices: {
      ...devices,
      issue: (request, options) =>
        runServingRequest(request, () => devices.issue(request, options)),
      revoke: (tokenId, request) =>
        request === undefined
          ? devices.revoke(tokenId)
          : runServingRequest(request, () => devices.revoke(tokenId, request)),
      current: (request) =>
        runServingRequest(request, () => devices.current(request)),
    },
    themes: {
      ...themes,
      install: (request, archive, options) =>
        runServingRequest(request, () =>
          themes.install(request, archive, options),
        ),
    },
  };
}
