import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ResolveAddresses } from "../network/outbound-address";
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

/**
 * A driver for the test gateway, which listens on loopback: private hosts are
 * allowed unless a case says otherwise, as whoever runs an instance with a
 * gateway on its own network would allow them.
 */
function driver(
  overrides: {
    endpoint?: string;
    token?: string;
    allowPrivateHosts?: boolean;
    resolve?: ResolveAddresses;
  } = {},
) {
  return new HttpGatewaySmsDriver({
    endpoint: overrides.endpoint ?? gateway.endpoint,
    token: overrides.token ?? gateway.token,
    requestTimeoutMs: 5000,
    allowPrivateHosts: overrides.allowPrivateHosts ?? true,
    ...(overrides.resolve === undefined ? {} : { resolve: overrides.resolve }),
  });
}

/** The test gateway's endpoint under a name the stub resolver answers for. */
function endpointNamed(hostname: string): string {
  const url = new URL(gateway.endpoint);
  url.hostname = hostname;
  return url.href;
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

  it("refuses a credential written into the address", async () => {
    const accepted = gateway.accepted.length;

    await expect(
      driver({
        endpoint: gateway.endpoint.replace("http://", "http://user:pass@"),
      }).send({ to: "+46701234567", body: "Nyhet" }),
    ).rejects.toBeInstanceOf(SmsError);
    expect(gateway.accepted).toHaveLength(accepted);
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

describe("where the gateway may be", () => {
  it("refuses a gateway on loopback unless private hosts are allowed", async () => {
    const requests = gateway.requests.length;

    // The database's own port: the shape of the probe this check exists for.
    for (const endpoint of [gateway.endpoint, "http://127.0.0.1:5432/"]) {
      await expect(
        driver({ endpoint, allowPrivateHosts: false }).send({
          to: "+46701234567",
          body: "Nyhet",
        }),
      ).rejects.toBeInstanceOf(SmsError);
    }
    expect(gateway.requests).toHaveLength(requests);
  });

  it("refuses a public-looking name that resolves somewhere private", async () => {
    // The name resolves to the test gateway itself, so a check that let it
    // through would show up as a request arriving there.
    const requests = gateway.requests.length;
    const resolve = vi.fn<ResolveAddresses>(() =>
      Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
    );

    await expect(
      driver({
        endpoint: endpointNamed("gateway.invalid"),
        allowPrivateHosts: false,
        resolve,
      }).send({ to: "+46701234567", body: "Nyhet" }),
    ).rejects.toBeInstanceOf(SmsError);
    expect(resolve).toHaveBeenCalledWith("gateway.invalid");
    expect(gateway.requests).toHaveLength(requests);
  });

  it("refuses the metadata service in one message with an unreachable gateway", async () => {
    const refused = await driver({
      endpoint: "http://169.254.169.254/latest/meta-data/",
      allowPrivateHosts: false,
    })
      .send({ to: "+46701234567", body: "Nyhet" })
      .catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(SmsError);
    // Which of the two the check found is a fact about the network.
    expect((refused as SmsError).message).toBe(
      "The SMS gateway could not be reached.",
    );
  });

  it("connects to the address it checked, not to a second resolution", async () => {
    // `.invalid` resolves nowhere, so the message arriving proves the socket
    // was opened to the answer the check judged rather than asking again.
    await driver({
      endpoint: endpointNamed("gateway.invalid"),
      resolve: () => Promise.resolve([{ address: "127.0.0.1", family: 4 }]),
    }).send({ to: "+46701234567", body: "Fastnålad" });

    expect(gateway.accepted.at(-1)).toMatchObject({ message: "Fastnålad" });
  });
});
