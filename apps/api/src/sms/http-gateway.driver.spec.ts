import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HttpGatewaySmsDriver } from "./http-gateway.driver";
import { SmsError } from "./sms.driver";
import {
  startSmsGatewayTestServer,
  type SmsGatewayTestServer,
} from "./testing/sms-gateway-test-server";

/**
 * The gateway driver against a real HTTP conversation.
 *
 * The contract this driver publishes is the conversation - the method, the
 * content type, the shape of the body and the bearer header - so it is tested
 * against a server that checks all four rather than against a stub of the
 * driver's own method, which would pass with every one of them wrong.
 */

let gateway: SmsGatewayTestServer;

beforeAll(async () => {
  gateway = await startSmsGatewayTestServer();
});

afterAll(async () => {
  await gateway.close();
});

function driver(overrides: { endpoint?: string; token?: string } = {}) {
  return new HttpGatewaySmsDriver({
    endpoint: overrides.endpoint ?? gateway.endpoint,
    token: overrides.token ?? gateway.token,
    requestTimeoutMs: 5000,
  });
}

describe("posting a message to the gateway", () => {
  it("sends the number, the body and the sender as documented JSON", async () => {
    await driver().send({
      to: "+46701234567",
      body: "Nyhet fran BRF Ekhagen",
      sender: "Ekhagen",
    });

    expect(gateway.accepted.at(-1)).toEqual({
      to: "+46701234567",
      message: "Nyhet fran BRF Ekhagen",
      from: "Ekhagen",
    });

    const request = gateway.requests.at(-1);
    expect(request?.method).toBe("POST");
    expect(request?.contentType).toBe("application/json");
  });

  it("leaves the sender out entirely when the association has not set one", async () => {
    // Not sent as null: a gateway reading an absent sender as "use the account
    // default" would otherwise be told to use no sender at all.
    await driver().send({ to: "+46701234567", body: "Nyhet" });

    expect(gateway.accepted.at(-1)).toEqual({
      to: "+46701234567",
      message: "Nyhet",
    });
    expect(
      JSON.parse(gateway.requests.at(-1)?.body ?? "{}"),
    ).not.toHaveProperty("from");
  });

  it("presents the configured credential", async () => {
    await driver().send({ to: "+46701234567", body: "Nyhet" });

    expect(gateway.requests.at(-1)?.authorization).toBe(
      `Bearer ${gateway.token}`,
    );
  });

  it("fails when the gateway does not accept the credential", async () => {
    const accepted = gateway.accepted.length;

    await expect(
      driver({ token: "wrong" }).send({ to: "+46701234567", body: "Nyhet" }),
    ).rejects.toBeInstanceOf(SmsError);
    expect(gateway.accepted).toHaveLength(accepted);
  });

  it("fails on a refusal without repeating what the gateway said", async () => {
    gateway.refuseNextWith(422, "invalid number +46701234567");

    const failure = await driver()
      .send({ to: "+46701234567", body: "Nyhet" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SmsError);
    // The status and nothing else. A refusal quotes the envelope back, and the
    // envelope is a member's phone number.
    expect((failure as SmsError).message).toBe(
      "The SMS gateway refused the message (HTTP 422).",
    );
    expect((failure as SmsError).message).not.toContain("+46701234567");
  });
});

describe("what the driver refuses to dial", () => {
  it("refuses an address that is not a URL", async () => {
    await expect(
      driver({ endpoint: "not a url" }).send({
        to: "+46701234567",
        body: "Nyhet",
      }),
    ).rejects.toBeInstanceOf(SmsError);
  });

  it("refuses a scheme that is not http or https", async () => {
    // The process that answers this call holds the member register, and this is
    // the one setting that tells it to dial somewhere.
    await expect(
      driver({ endpoint: "file:///etc/passwd" }).send({
        to: "+46701234567",
        body: "Nyhet",
      }),
    ).rejects.toBeInstanceOf(SmsError);
  });

  it("reports an unreachable gateway rather than throwing something else", async () => {
    await expect(
      driver({ endpoint: "http://127.0.0.1:1/send" }).send({
        to: "+46701234567",
        body: "Nyhet",
      }),
    ).rejects.toBeInstanceOf(SmsError);
  });
});
