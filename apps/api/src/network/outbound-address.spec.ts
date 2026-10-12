import { connect, createServer, type Server } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  isPublicAddress,
  OutboundAddressError,
  pinnedLookup,
  type ResolvedAddress,
  resolvePublicAddresses,
} from "./outbound-address";

/**
 * The address rule every connection made on somebody's word is held to.
 *
 * The resolver is a stub throughout: a suite that judged real names would
 * depend on somebody else's DNS zone for whether it passes.
 */

function answers(...addresses: string[]): () => Promise<ResolvedAddress[]> {
  return () =>
    Promise.resolve(
      addresses.map((address) => ({
        address,
        family: address.includes(":") ? (6 as const) : (4 as const),
      })),
    );
}

describe("isPublicAddress", () => {
  it("accepts an ordinary public address in either family", () => {
    expect(isPublicAddress("1.1.1.1")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("refuses loopback, the private ranges and link-local", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.3.4",
      "192.168.1.10",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("refuses the metadata service however it is written", () => {
    expect(isPublicAddress("169.254.169.254")).toBe(false);
    expect(isPublicAddress("::ffff:169.254.169.254")).toBe(false);
    expect(isPublicAddress("64:ff9b::a9fe:a9fe")).toBe(false);
    expect(isPublicAddress("2002:a9fe:a9fe::")).toBe(false);
  });

  it("refuses what it cannot parse", () => {
    expect(isPublicAddress("fe80::1%eth0")).toBe(false);
    expect(isPublicAddress("not an address")).toBe(false);
  });
});

describe("resolvePublicAddresses", () => {
  it("returns every answer when all of them are public", async () => {
    await expect(
      resolvePublicAddresses("gateway.example", {
        allowPrivate: false,
        resolve: answers("1.1.1.1", "2606:4700:4700::1111"),
      }),
    ).resolves.toEqual([
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  it("refuses a name that resolves somewhere private", async () => {
    await expect(
      resolvePublicAddresses("gateway.example", {
        allowPrivate: false,
        resolve: answers("169.254.169.254"),
      }),
    ).rejects.toMatchObject({ code: "address-not-public" });
  });

  it("refuses when any answer is private, not only the first", async () => {
    await expect(
      resolvePublicAddresses("gateway.example", {
        allowPrivate: false,
        resolve: answers("1.1.1.1", "10.0.0.5"),
      }),
    ).rejects.toMatchObject({ code: "address-not-public" });
  });

  it("judges an address written as the host without asking the resolver", async () => {
    const resolve = vi.fn(answers("1.1.1.1"));

    await expect(
      resolvePublicAddresses("127.0.0.1", { allowPrivate: false, resolve }),
    ).rejects.toMatchObject({ code: "address-not-public" });
    await expect(
      resolvePublicAddresses("[::1]", { allowPrivate: false, resolve }),
    ).rejects.toMatchObject({ code: "address-not-public" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("refuses a name that resolves to nothing, or not at all", async () => {
    await expect(
      resolvePublicAddresses("gateway.example", {
        allowPrivate: false,
        resolve: answers(),
      }),
    ).rejects.toMatchObject({ code: "host-not-resolved" });
    await expect(
      resolvePublicAddresses("gateway.example", {
        allowPrivate: false,
        resolve: () => Promise.reject(new Error("ENOTFOUND")),
      }),
    ).rejects.toMatchObject({ code: "host-not-resolved" });
  });

  it("says the same thing however it refused", async () => {
    const private_ = await resolvePublicAddresses("a.example", {
      allowPrivate: false,
      resolve: answers("10.0.0.5"),
    }).catch((error: unknown) => error);
    const missing = await resolvePublicAddresses("b.example", {
      allowPrivate: false,
      resolve: answers(),
    }).catch((error: unknown) => error);

    expect(private_).toBeInstanceOf(OutboundAddressError);
    expect(missing).toBeInstanceOf(OutboundAddressError);
    expect((private_ as Error).message).toBe((missing as Error).message);
  });

  it("lets a private address through where the operator allowed it", async () => {
    await expect(
      resolvePublicAddresses("relay.lan.example", {
        allowPrivate: true,
        resolve: answers("192.168.1.10"),
      }),
    ).resolves.toEqual([{ address: "192.168.1.10", family: 4 }]);
  });
});

describe("pinnedLookup", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((socket) => {
      socket.end("pinned");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the test server has no port");
    }
    port = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  it("connects to the address it was given, whatever the name resolves to", async () => {
    // `.invalid` never resolves, so reaching the server proves the connection
    // used the pinned answer and never asked the resolver.
    const received = await new Promise<string>((resolve, reject) => {
      const socket = connect({
        host: "pinned.invalid",
        port,
        lookup: pinnedLookup([{ address: "127.0.0.1", family: 4 }]),
      });
      let data = "";
      socket.on("data", (chunk) => (data += chunk.toString()));
      socket.on("end", () => {
        resolve(data);
      });
      socket.on("error", reject);
    });

    expect(received).toBe("pinned");
  });

  it("answers in both shapes the runtime asks for", () => {
    const lookup = pinnedLookup([
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
    ]);

    const one = vi.fn();
    lookup("gateway.example", { family: 4 }, one);
    expect(one).toHaveBeenCalledWith(null, "1.1.1.1", 4);

    const all = vi.fn();
    lookup("gateway.example", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "1.1.1.1", family: 4 },
    ]);
  });
});
