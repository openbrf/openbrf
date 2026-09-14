import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { describe, expect, it } from "vitest";

import {
  createGuardedMetadataFetch,
  guardedMetadataFetch,
  isMetadataDocumentUrlAllowed,
  MetadataFetchError,
  REAL_DEPENDENCIES,
} from "./cimd-fetch";

/**
 * The one address an unauthenticated party chooses for this server.
 *
 * A connected app names a URL as its identity and this process fetches it, so
 * every rule below is a rule about what a stranger can point it at. The cases
 * that matter are not the obvious ones - nobody attacks with
 * `https://localhost/` - but the forms that read as public and are not: an
 * address written as an integer, a name under a suffix that means something
 * else inside a network, a public name whose A record is 169.254.169.254, and
 * a public host that answers with a redirect into the compose network.
 *
 * Nothing here resolves a name or opens a socket. Both are supplied as stubs,
 * because a suite that resolved real names would be asserting facts about
 * somebody else's DNS zone, and the interesting answers - a name resolving to a
 * hosting provider's metadata service - are ones no zone will give.
 */

/** Two ordinary public answers, one per family. */
const PUBLIC_ADDRESSES: readonly string[] = ["93.184.216.34", "2606:2800::1"];

const CLIENT_ID = "https://apps.example.se/mcp/client.json";

interface Hop {
  url: string;
  init: RequestInit;
}

interface Harness {
  call: ReturnType<typeof createGuardedMetadataFetch>;
  hops: Hop[];
  resolved: string[];
}

/**
 * A transport whose resolver and socket are recorded rather than real.
 *
 * `answers` maps a hostname to what the resolver returns for it and defaults to
 * a public pair; `reply` is consulted per hop, so a redirect chain is written
 * as the sequence of responses the hosts in it would give.
 */
function harness(
  options: {
    answers?: Readonly<Record<string, readonly string[]>>;
    reply?: (hop: Hop, index: number) => Promise<Response> | Response;
    timeoutMs?: number;
    maxRedirects?: number;
    maxResponseBytes?: number;
  } = {},
): Harness {
  const hops: Hop[] = [];
  const resolved: string[] = [];

  const call = createGuardedMetadataFetch({
    resolve: async (hostname) => {
      resolved.push(hostname);
      return await Promise.resolve(
        options.answers?.[hostname] ?? PUBLIC_ADDRESSES,
      );
    },
    fetch: async (url, init) => {
      const hop: Hop = { url, init };
      hops.push(hop);
      return await (options.reply?.(hop, hops.length - 1) ??
        Promise.resolve(json({ client_id: url })));
    },
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
    ...(options.maxRedirects === undefined
      ? {}
      : { maxRedirects: options.maxRedirects }),
    ...(options.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: options.maxResponseBytes }),
  });

  return { call, hops, resolved };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function redirectTo(location: string, status = 302): Response {
  return new Response("moved", { headers: { location }, status });
}

/** A body delivered in chunks, the way a socket delivers one. */
function streamed(
  bytes: number,
  headers: Record<string, string> = {},
): Response {
  const chunk = 1024;
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= bytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunk, bytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x61));
    },
  });
  return new Response(stream, { headers, status: 200 });
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (cause) {
    if (cause instanceof MetadataFetchError) {
      return cause.code;
    }
    return `not a MetadataFetchError: ${String(cause)}`;
  }
  return "resolved";
}

describe("isMetadataDocumentUrlAllowed", () => {
  it("allows an ordinary client id on a public name", () => {
    expect(isMetadataDocumentUrlAllowed(CLIENT_ID)).toBe(true);
    expect(
      isMetadataDocumentUrlAllowed("https://a.b.c.example.co.uk/x?y=1"),
    ).toBe(true);
    // Hyphens inside a label and a punycode label are both ordinary names. A
    // rule tightened until it refuses these has stopped being a security
    // boundary and started being an outage.
    expect(isMetadataDocumentUrlAllowed("https://my-app.example.se/c")).toBe(
      true,
    );
    expect(
      isMetadataDocumentUrlAllowed("https://xn--rksmrgs-5wao1o.se/client"),
    ).toBe(true);
  });

  it("refuses every scheme but https", () => {
    // http is refused with the rest: the document is an identity, and an
    // identity nobody proved is not one. `file:` and `data:` are in the list
    // because a scheme allow-list written as "not this one" is how they arrive.
    for (const url of [
      "http://apps.example.se/c",
      "file:///etc/passwd",
      "ftp://apps.example.se/c",
      "data:application/json,{}",
      "javascript:fetch('/')",
      "blob:https://apps.example.se/abc",
    ]) {
      expect(isMetadataDocumentUrlAllowed(url)).toBe(false);
    }
  });

  it("refuses text that is not a URL", () => {
    for (const url of ["", "apps.example.se", "https://", "://x", "  "]) {
      expect(isMetadataDocumentUrlAllowed(url)).toBe(false);
    }
  });

  it("refuses credentials in the URL", () => {
    // A caller that can put a credential in the URL has made this process an
    // authenticating client of whatever it names, with a secret the caller
    // chose.
    expect(
      isMetadataDocumentUrlAllowed("https://user:pass@apps.example.se/c"),
    ).toBe(false);
    expect(isMetadataDocumentUrlAllowed("https://user@apps.example.se/c")).toBe(
      false,
    );
  });

  it("refuses a port, and accepts the default written out", () => {
    // A client id is a public HTTPS URL a person can open; an explicit port
    // buys a real client nothing and turns this server into a port scanner,
    // because how long a refusal takes is itself an answer. 443 is normalised
    // away before the check, so naming it changes nothing.
    expect(isMetadataDocumentUrlAllowed("https://apps.example.se:8443/c")).toBe(
      false,
    );
    expect(isMetadataDocumentUrlAllowed("https://apps.example.se:22/c")).toBe(
      false,
    );
    expect(isMetadataDocumentUrlAllowed("https://apps.example.se:443/c")).toBe(
      true,
    );
  });

  it("refuses an address literal in either family", () => {
    for (const url of [
      "https://93.184.216.34/c",
      "https://127.0.0.1/c",
      "https://169.254.169.254/latest/meta-data/",
      "https://[::1]/c",
      "https://[2606:2800::1]/c",
      // Loopback wrapped in IPv6, which the runtime rewrites to
      // `[::ffff:7f00:1]` - a form a check looking for "127." would miss.
      "https://[::ffff:127.0.0.1]/c",
      "https://[::ffff:7f00:1]/c",
    ]) {
      expect(isMetadataDocumentUrlAllowed(url)).toBe(false);
    }
  });

  it("refuses loopback written as a number", () => {
    // All three of these are 127.0.0.1, and each is what somebody reaches for
    // once the dotted form is refused. The runtime folds them into the dotted
    // form, and the rule that the last label must begin with a letter refuses
    // them again whether it does or not.
    for (const url of [
      "https://2130706433/c",
      "https://017700000001/c",
      "https://0x7f000001/c",
      "https://1.1/c",
      "https://0/c",
    ]) {
      expect(isMetadataDocumentUrlAllowed(url)).toBe(false);
    }
  });

  it("refuses a host whose last label is a number", () => {
    // Independent of how the runtime chooses to parse it. No delegated
    // top-level domain is numeric, so a name ending in one is an address in
    // some notation - and which notations the URL parser folds is its own
    // behaviour rather than a promise it has made.
    for (const url of [
      "https://example.123/c",
      "https://example.0x1/c",
      "https://a.b.0/c",
    ]) {
      expect(isMetadataDocumentUrlAllowed(url)).toBe(false);
    }
  });

  it("refuses localhost, however it is spelled", () => {
    for (const url of [
      "https://localhost/c",
      "https://api.localhost/c",
      "https://LOCALHOST/c",
      "https://LocalHost/c",
    ]) {
      expect(isMetadataDocumentUrlAllowed(url)).toBe(false);
    }
  });

  it("refuses the suffixes that mean something else inside a network", () => {
    // Each of these resolves to a host on the deployment's own network or to
    // nothing at all. `.internal` is what two large hosting providers call
    // their private zone; the rest are what a site invents when it needs one.
    for (const host of [
      "printer.local",
      "db.internal",
      "api.intranet",
      "api.intra",
      "api.private",
      "mail.corp",
      "nas.home",
      "nas.lan",
      "box.localdomain",
      "router.home.arpa",
      "1.0.168.192.in-addr.arpa",
      "anything.test",
      "anything.invalid",
      "anything.example",
      "anything.alt",
      "secret.onion",
      "PRINTER.LOCAL",
    ]) {
      expect(isMetadataDocumentUrlAllowed(`https://${host}/c`)).toBe(false);
    }
  });

  it("refuses a single-label host", () => {
    // A name with no dot is one only a search domain completes, which is what a
    // container name, a compose service and a Kubernetes service all are:
    // `postgres`, `redis`, `api` all resolve inside the network and nowhere
    // else.
    for (const host of ["postgres", "redis", "api", "metadata"]) {
      expect(isMetadataDocumentUrlAllowed(`https://${host}/c`)).toBe(false);
    }
  });

  it("refuses a trailing dot", () => {
    // `apps.example.se.` and `apps.example.se` are one host written two ways.
    // Allowing both would give one client two identities, since the client id
    // is compared as text against what the document declares - and it is also
    // the oldest way past a suffix check.
    expect(isMetadataDocumentUrlAllowed("https://apps.example.se./c")).toBe(
      false,
    );
    expect(isMetadataDocumentUrlAllowed("https://localhost./c")).toBe(false);
    expect(isMetadataDocumentUrlAllowed("https://printer.local./c")).toBe(
      false,
    );
  });

  it("refuses a host that is not a sequence of labels", () => {
    for (const host of [
      "a..b",
      "-bad.example.se",
      "bad-.example.se",
      "ex_ample.se",
      `${"a".repeat(64)}.example.se`,
      `${"a.".repeat(130)}example.se`,
    ]) {
      expect(isMetadataDocumentUrlAllowed(`https://${host}/c`)).toBe(false);
    }
  });
});

describe("what the transport is composed of", () => {
  it("opens its sockets with the pinned transport, not the global fetch", async () => {
    // The rebinding argument in this module rests entirely on which function
    // this is. The package's transport resolves once and connects to the
    // address it approved; the global fetch resolves again inside itself, so
    // the checks in this module would be judging a resolution the socket never
    // used. Identity is what that claim reduces to, and it is checkable without
    // a socket - unlike the pinning itself, which is a property of that
    // function's source rather than anything a test with no network can show.
    expect(REAL_DEPENDENCIES.fetch).toBe(fetchClientMetadataResource);
    expect(REAL_DEPENDENCIES.fetch).not.toBe(globalThis.fetch);

    // And it behaves like a transport with a policy of its own rather than a
    // plain socket: a non-HTTPS URL is refused on the text, before a name is
    // looked up or a connection attempted. The global fetch would try to
    // connect here.
    await expect(
      REAL_DEPENDENCIES.fetch("http://apps.example.se/c", { method: "GET" }),
    ).rejects.toThrow(TypeError);
  });

  it("keeps the bounds the module decided on", () => {
    // Numbers a change should have to be deliberate about. They are the only
    // time and size limits in the path now: the transport below carries
    // neither, and the discovery layer above applies its own to the metadata
    // document but not to the other resources this carries.
    expect(REAL_DEPENDENCIES.timeoutMs).toBe(4000);
    expect(REAL_DEPENDENCIES.maxRedirects).toBe(3);
    expect(REAL_DEPENDENCIES.maxResponseBytes).toBe(64 * 1024);
  });
});

describe("the guarded transport", () => {
  it("refuses through the exported transport too", async () => {
    // Everything below drives an instance built with stubs, so this is the one
    // case that runs what the auth options actually hand over. It is a URL the
    // synchronous check refuses, which is refused before the resolver or the
    // socket is reached - so the assertion holds without a lookup or a
    // connection, and a seam whose default had drifted away from the guard
    // would show up here rather than in a suite passing against stubs.
    expect(await codeOf(guardedMetadataFetch("https://localhost/c"))).toBe(
      "url-not-allowed",
    );
    expect(
      await codeOf(guardedMetadataFetch("https://169.254.169.254/latest/")),
    ).toBe("url-not-allowed");
    expect(
      await codeOf(guardedMetadataFetch(CLIENT_ID, { method: "POST" })),
    ).toBe("method-not-allowed");
  });

  it("returns a document the caller can read", async () => {
    const { call, hops, resolved } = harness();

    const response = await call(CLIENT_ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ client_id: CLIENT_ID });
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(resolved).toEqual(["apps.example.se"]);
    expect(hops.map((hop) => hop.url)).toEqual([CLIENT_ID]);
  });

  it("checks the URL before it resolves or connects", async () => {
    const { call, hops, resolved } = harness();

    expect(await codeOf(call("https://10.0.0.5/c"))).toBe("url-not-allowed");

    // The order is the point. A refusal that happened after the lookup would
    // still have asked this deployment's resolver about a name the caller
    // chose, and one that happened after the socket would have connected.
    expect(resolved).toEqual([]);
    expect(hops).toEqual([]);
  });

  it("tells the runtime not to follow redirects, and carries the headers", async () => {
    const { call, hops } = harness();

    await call(CLIENT_ID, {
      headers: { accept: "application/json", "if-none-match": '"abc"' },
    });

    const hop = hops[0];
    // Left to the runtime, a redirect is followed before anything here sees it,
    // and the address checks would have run only against the URL the caller
    // wrote.
    expect(hop?.init.redirect).toBe("manual");
    expect(hop?.init.method).toBe("GET");
    expect(new Headers(hop?.init.headers).get("if-none-match")).toBe('"abc"');
    expect(hop?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a public name that resolves somewhere private", async () => {
    // The case the URL check cannot see and the whole reason the transport
    // resolves at all: nothing about `apps.example.se` says where it points,
    // and the caller owns the zone that answers.
    const { call, hops } = harness({
      answers: { "apps.example.se": ["169.254.169.254"] },
    });

    expect(await codeOf(call(CLIENT_ID))).toBe("address-not-public");
    expect(hops).toEqual([]);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["loopback, not the first address in the range", "127.4.5.6"],
    ["private class A", "10.1.2.3"],
    ["private class B", "172.20.0.7"],
    ["private class C", "192.168.1.1"],
    ["the instance metadata service", "169.254.169.254"],
    ["link-local", "169.254.1.1"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["unspecified", "0.0.0.0"],
    ["this network", "0.1.2.3"],
    ["broadcast", "255.255.255.255"],
    ["reserved", "240.0.0.1"],
    ["multicast", "224.0.0.1"],
    ["benchmarking", "198.18.0.1"],
    ["documentation", "192.0.2.1"],
    ["protocol assignments", "192.0.0.1"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unspecified", "::"],
    ["IPv6 link-local", "fe80::1"],
    ["unique local", "fd12:3456:789a::1"],
    ["unique local, low half", "fc00::1"],
    ["IPv6 multicast", "ff02::1"],
    ["Teredo", "2001::1"],
    ["IPv6 documentation", "2001:db8::1"],
    ["6to4 wrapping loopback", "2002:7f00:1::"],
    ["NAT64 wrapping loopback", "64:ff9b::7f00:1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped loopback in hex", "::ffff:7f00:1"],
    ["IPv4-mapped metadata service", "::ffff:169.254.169.254"],
    ["IPv4-mapped private", "::ffff:10.0.0.1"],
    ["something the runtime cannot parse", "not-an-address"],
  ])("refuses an answer that is %s", async (_case, address) => {
    const { call, hops } = harness({
      answers: { "apps.example.se": [address] },
    });

    expect(await codeOf(call(CLIENT_ID))).toBe("address-not-public");
    expect(hops).toEqual([]);
  });

  it("refuses when any answer is private, not only the first", async () => {
    // A name may carry several records and the resolver may hand them back in
    // any order, rotating between calls. Checking one of them would leave where
    // this server connects up to a round robin - and the public record is there
    // precisely so the first one checked looks fine.
    const { call } = harness({
      answers: {
        "apps.example.se": ["93.184.216.34", "93.184.216.35", "127.0.0.1"],
      },
    });

    expect(await codeOf(call(CLIENT_ID))).toBe("address-not-public");
  });

  it("refuses a name that resolves to nothing, or not at all", async () => {
    const empty = harness({ answers: { "apps.example.se": [] } });
    expect(await codeOf(empty.call(CLIENT_ID))).toBe("host-not-resolved");

    const failing = createGuardedMetadataFetch({
      resolve: async () => {
        await Promise.resolve();
        throw Object.assign(new Error("getaddrinfo ENOTFOUND"), {
          code: "ENOTFOUND",
        });
      },
      fetch: async () => await Promise.resolve(json({})),
    });
    expect(await codeOf(failing(CLIENT_ID))).toBe("host-not-resolved");
  });

  it("re-resolves the host of every hop", async () => {
    // The standard way past a check done once: answer the first request from a
    // public host and redirect to a name whose records point inside. The second
    // host is never connected to, because the second lookup is what refuses it.
    const { call, hops, resolved } = harness({
      answers: {
        "apps.example.se": ["93.184.216.34"],
        "cdn.example.se": ["169.254.169.254"],
      },
      reply: (hop) =>
        hop.url === CLIENT_ID
          ? redirectTo("https://cdn.example.se/c")
          : json({}),
    });

    expect(await codeOf(call(CLIENT_ID))).toBe("address-not-public");
    expect(resolved).toEqual(["apps.example.se", "cdn.example.se"]);
    expect(hops).toHaveLength(1);
  });

  it("re-reads the URL of every hop", async () => {
    // The same attack aimed at the text rather than the records. A hop is a URL
    // the caller's host wrote, so it goes back through the same gate the
    // caller's own URL did - scheme, port, credentials and host alike.
    for (const location of [
      "http://apps.example.se/c",
      "https://localhost/c",
      "https://127.0.0.1/c",
      "https://apps.example.se:9200/c",
      "https://db.internal/c",
      "https://[::1]/c",
    ]) {
      const { call, hops } = harness({
        reply: (hop) =>
          hop.url === CLIENT_ID ? redirectTo(location) : json({}),
      });

      expect(await codeOf(call(CLIENT_ID))).toBe("url-not-allowed");
      expect(hops).toHaveLength(1);
    }
  });

  it("refuses a redirect outright when the caller asked it to", async () => {
    // How the discovery layer calls this transport. A metadata document has to
    // be served at the client id URL for the URL to be an identity at all: an
    // open redirect on an honest client's host would otherwise let a stranger
    // serve that client's metadata, and every hop check in the world is about
    // where the socket goes rather than whose document comes back.
    const { call, hops } = harness({
      reply: () => redirectTo("https://cdn.example.se/c"),
    });

    expect(
      await codeOf(call(CLIENT_ID, { redirect: "error", method: "GET" })),
    ).toBe("redirect-refused");
    expect(hops).toHaveLength(1);
  });

  it("hands a redirect back when the caller asked for that instead", async () => {
    const { call } = harness({
      reply: () => redirectTo("https://cdn.example.se/c", 301),
    });

    const response = await call(CLIENT_ID, { redirect: "manual" });

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("https://cdn.example.se/c");
    expect(response.redirected).toBe(false);
  });

  it("follows a hop and says that it did", async () => {
    const { call, hops } = harness({
      reply: (hop) =>
        hop.url === CLIENT_ID
          ? redirectTo("https://cdn.example.se/c")
          : json({ client_id: CLIENT_ID }),
    });

    const response = await call(CLIENT_ID);

    expect(response.status).toBe(200);
    expect(hops.map((hop) => hop.url)).toEqual([
      CLIENT_ID,
      "https://cdn.example.se/c",
    ]);
    // Rebuilding the response to bound its body loses the runtime's own record
    // of the hop. A consumer that refuses a redirected document would then be
    // reading a fact this transport had erased.
    expect(response.redirected).toBe(true);
  });

  it("stops after the hop limit", async () => {
    // A chain is a request each, all of them made by this process on behalf of
    // someone who has not authenticated. Unbounded, two hosts pointing at each
    // other is an endless loop inside a request handler.
    const { call, hops } = harness({
      maxRedirects: 2,
      reply: (_hop, index) =>
        redirectTo(`https://apps.example.se/hop-${String(index)}`),
    });

    expect(await codeOf(call(CLIENT_ID))).toBe("too-many-redirects");
    expect(hops).toHaveLength(3);
  });

  it("refuses a redirect to something that is not a URL", async () => {
    const { call } = harness({ reply: () => redirectTo("http://") });

    expect(await codeOf(call(CLIENT_ID))).toBe("url-not-allowed");
  });

  it("refuses a redirect with no location to follow", async () => {
    const { call } = harness({
      reply: () => new Response("gone", { status: 302 }),
    });

    expect(await codeOf(call(CLIENT_ID))).toBe("transport-failed");
  });

  it("drops a credential on a hop to another origin", async () => {
    const { call, hops } = harness({
      reply: (hop, index) =>
        index === 0
          ? redirectTo("https://apps.example.se/same-origin")
          : index === 1
            ? redirectTo("https://cdn.example.se/other-origin")
            : json({}),
    });

    await call(CLIENT_ID, {
      headers: { authorization: "Bearer secret", accept: "application/json" },
    });

    // Same origin keeps it; the hop across does not. A host that answers with a
    // redirect it chose must not be able to collect a header addressed to
    // somewhere else.
    expect(new Headers(hops[1]?.init.headers).get("authorization")).toBe(
      "Bearer secret",
    );
    expect(new Headers(hops[2]?.init.headers).get("authorization")).toBe(null);
    expect(new Headers(hops[2]?.init.headers).get("accept")).toBe(
      "application/json",
    );
  });

  it("stops reading a body that runs past the limit", async () => {
    // The header says the body is tiny and the body is not. A limit taken from
    // `content-length` is a limit the sender sets, and this sender is the one
    // being defended against; under chunked encoding there is no header at all.
    const { call } = harness({
      maxResponseBytes: 4096,
      reply: () => streamed(64 * 1024, { "content-length": "12" }),
    });

    expect(await codeOf(call(CLIENT_ID))).toBe("response-too-large");
  });

  it("stops reading a body that declares no length at all", async () => {
    const { call } = harness({
      maxResponseBytes: 4096,
      reply: () => streamed(64 * 1024),
    });

    expect(await codeOf(call(CLIENT_ID))).toBe("response-too-large");
  });

  it("reads a body that stops exactly at the limit", async () => {
    // The boundary in the direction that breaks a real client. An
    // off-by-one here refuses documents that are within the bound.
    const { call } = harness({
      maxResponseBytes: 4096,
      reply: () => streamed(4096),
    });

    const response = await call(CLIENT_ID);

    expect((await response.arrayBuffer()).byteLength).toBe(4096);
    // Rewritten to what was read, so nothing downstream reasons about the body
    // using a number the sender supplied.
    expect(response.headers.get("content-length")).toBe("4096");
  });

  it("gives up on a host that answers and then stalls", async () => {
    // The shape that costs the most: the connection is accepted, so nothing
    // fails, and the socket is simply held. Without a budget on the whole
    // operation each such request occupies a handler for as long as the caller
    // cares to keep it.
    const { call } = harness({
      timeoutMs: 10,
      reply: async (hop) =>
        await new Promise<Response>((_resolve, reject) => {
          hop.init.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        }),
    });

    expect(await codeOf(call(CLIENT_ID))).toBe("timed-out");
  });

  it("holds the budget even when the transport ignores the signal", async () => {
    // A deadline that only fires when the layer below cooperates is not a
    // deadline. This stub never looks at the signal.
    const { call } = harness({
      timeoutMs: 10,
      reply: async () => await new Promise<Response>(() => undefined),
    });

    expect(await codeOf(call(CLIENT_ID))).toBe("timed-out");
  });

  it("passes the caller's own cancellation through, told apart from a timeout", async () => {
    const controller = new AbortController();
    const { call } = harness({
      timeoutMs: 60_000,
      reply: async () => await new Promise<Response>(() => undefined),
    });

    const pending = call(CLIENT_ID, { signal: controller.signal });
    controller.abort();

    // Separate codes because they are separate facts in a log: the caller gave
    // up, or this host did not answer in time.
    expect(await codeOf(pending)).toBe("aborted");
  });

  it("refuses a method that does more than read", async () => {
    // Nothing this transport exists for needs one. A caller-chosen URL reached
    // with a state-changing verb is the difference between reading an internal
    // service and operating it.
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const { call, hops, resolved } = harness();
      expect(await codeOf(call(CLIENT_ID, { method }))).toBe(
        "method-not-allowed",
      );
      expect(resolved).toEqual([]);
      expect(hops).toEqual([]);
    }
  });

  it("returns a body-less answer unchanged", async () => {
    // The conditional request the discovery layer makes when it revalidates a
    // cached document. A 304 may not carry a body, so rebuilding one around
    // bytes that were never there would throw rather than answer.
    const { call } = harness({
      reply: () =>
        new Response(null, { headers: { etag: '"abc"' }, status: 304 }),
    });

    const response = await call(CLIENT_ID, {
      headers: { "if-none-match": '"abc"' },
    });

    expect(response.status).toBe(304);
    expect(response.body).toBe(null);
    expect(response.headers.get("etag")).toBe('"abc"');
  });

  it("says the same thing however it refused", async () => {
    // What crosses the wire. The discovery layer turns this into an OAuth error
    // the caller reads, so any message that distinguished the categories would
    // let a stranger map this network one client id at a time: "that address is
    // not public" and "that host does not resolve" are two different facts
    // about the inside of the deployment. The category stays on the error for
    // the log, and the log is the only place it goes.
    const refusals = [
      harness().call("https://10.0.0.5/c"),
      harness({ answers: { "apps.example.se": ["169.254.169.254"] } }).call(
        CLIENT_ID,
      ),
      harness({ answers: { "apps.example.se": [] } }).call(CLIENT_ID),
      harness({ maxResponseBytes: 16, reply: () => streamed(4096) }).call(
        CLIENT_ID,
      ),
      harness({ reply: () => redirectTo("https://db.internal/c") }).call(
        CLIENT_ID,
        { redirect: "error" },
      ),
    ];

    const messages = new Set<string>();
    const codes = new Set<string>();

    for (const refusal of refusals) {
      await expect(refusal).rejects.toBeInstanceOf(MetadataFetchError);
      await refusal.catch((cause: unknown) => {
        if (cause instanceof MetadataFetchError) {
          messages.add(cause.message);
          codes.add(cause.code);
        }
      });
    }

    expect(messages.size).toBe(1);
    expect(codes.size).toBe(refusals.length);

    const [message] = [...messages];
    for (const leak of [
      "10.0.0.5",
      "169.254.169.254",
      "apps.example.se",
      "db.internal",
      CLIENT_ID,
    ]) {
      expect(message).not.toContain(leak);
    }
  });
});
