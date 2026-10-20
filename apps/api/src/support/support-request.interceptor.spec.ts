import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { firstValueFrom, from } from "rxjs";
import { describe, expect, it } from "vite-plus/test";

import { actingSupportSession } from "../audit/acting-support-session";
import { SupportRequestInterceptor } from "./support-request.interceptor";

function contextFor(request: object): ExecutionContext {
  return {
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

/** A handler that reports the support session it ran under, after awaiting. */
const reporting: CallHandler = {
  handle: () =>
    from(
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return actingSupportSession();
      })(),
    ),
};

describe("the support request interceptor", () => {
  it("runs a support session's handler inside its storage", async () => {
    const interceptor = new SupportRequestInterceptor();
    const request = { support: { sessionId: "support-session-1" } };

    await expect(
      firstValueFrom(interceptor.intercept(contextFor(request), reporting)),
    ).resolves.toBe("support-session-1");
  });

  it("leaves any other request outside it", async () => {
    const interceptor = new SupportRequestInterceptor();

    await expect(
      firstValueFrom(interceptor.intercept(contextFor({}), reporting)),
    ).resolves.toBeNull();
  });
});
