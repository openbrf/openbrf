import { EventEmitter } from "node:events";

import type { HttpAdapterHost } from "@nestjs/core";
import type { PluginHost } from "@openbrf/plugin-sdk";

import { runServingRequest, ServedRequestHook } from "../served-request";

/**
 * Runs `work` in the scope `ServedRequestHook` opens for `request`, as the
 * HTTP server runs a route, with `end` to send the response, which closes it.
 * For tests of a request whose response ends while a member waits.
 */
export function servingUntilAnswered<T>(
  request: object,
  work: () => T,
): { result: T; end: () => void } {
  type Hook = (
    request: object,
    reply: { raw: EventEmitter },
    done: () => void,
  ) => void;
  let hook: Hook | null = null;
  new ServedRequestHook({
    httpAdapter: {
      getInstance: () => ({
        addHook: (_name: string, added: Hook) => {
          hook = added;
        },
      }),
    },
  } as unknown as HttpAdapterHost).onModuleInit();
  const raw = Object.assign(new EventEmitter(), {
    writableFinished: false,
    destroyed: false,
  });
  let result: { value: T } | null = null;
  (hook as Hook | null)?.(request, { raw }, () => {
    result = { value: work() };
  });
  if (result === null) {
    throw new Error("ServedRequestHook added no preHandler hook.");
  }
  return {
    result: (result as { value: T }).value,
    end: () => {
      raw.writableFinished = true;
      raw.emit("close");
    },
  };
}

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
