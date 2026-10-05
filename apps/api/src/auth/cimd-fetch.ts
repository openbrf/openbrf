import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";

/**
 * Fetching the metadata document a client names as its own identity.
 *
 * A connected app signs in by presenting a URL as its client id, and this
 * server fetches the document at that URL to learn what the app is. Nothing has
 * authenticated at that point and nothing has been installed: the address is
 * chosen by whoever made the request, which makes this the one place in the
 * product where an unauthenticated party decides where this process connects.
 *
 * That is server-side request forgery in its plainest form, and the shape of
 * the deployment is what gives it value. The process holding the member
 * register runs in a compose network beside a database, a job queue and a mail
 * relay, none of which is reachable from outside it; a hosting provider's
 * instance metadata service answers on a fixed link-local address from inside
 * every container, and returns credentials to anything that asks. A client id
 * that resolves to one of those makes this server the thing that reaches it and
 * reports back what it said.
 *
 * The bound is therefore here rather than left to the discovery plugin. The
 * plugin takes a fetch function and documents what that function must
 * guarantee - resolve once, refuse special-use addresses, pin the connection -
 * but a requirement stated on a function this application supplies is a
 * description of this file's job, not a check performed on its behalf.
 *
 * Two exports, both passed to the discovery plugin by the auth options. The
 * first is a synchronous judgement on the URL as written, which the plugin
 * calls before it decides to fetch anything at all. The second is the transport
 * that runs when it does, and it repeats the first check rather than trusting
 * that it happened, because a redirect arrives at this layer and never passes
 * through the first one.
 *
 * The socket itself is not opened here. The last step of each hop is the
 * package's own Node transport, which resolves the name once, refuses unless
 * every answer is publicly routable, and then pins that address for the
 * connection while the hostname remains the Host header, the TLS server name
 * and the identity the certificate is checked against. That pinning is what
 * closes the gap between deciding an address is acceptable and connecting to
 * it: a name whose records change between the two - the shape an attacker with
 * an authoritative nameserver arranges - cannot move the connection, because
 * the connection no longer consults the resolver. It carries no time or size
 * bound of its own, which is what the rest of this file is.
 *
 * The window reopens if the `fetch` dependency below is replaced with one that
 * resolves the name separately from the connection it then makes - the global
 * fetch among them. The checks here would still refuse every address the
 * resolver admitted to, and would still be looking at a different resolution
 * from the one the socket used.
 */

/** The longest a hostname can be, in the presentation form a URL carries. */
const MAX_HOSTNAME_LENGTH = 253;

/**
 * One DNS label: letters, digits and inner hyphens, at most 63 characters.
 *
 * Lower case only, because the URL parser has already case-folded the host and
 * converted any non-ASCII label to its punycode form. An empty label fails
 * this, which is what refuses both a trailing dot and `a..b`.
 */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The last label, which must begin with a letter.
 *
 * No delegated top-level domain is numeric, and internationalised ones arrive
 * as `xn--`, so requiring a leading letter costs a real client nothing. What it
 * buys is the whole family of addresses written as integers. `2130706433`,
 * `0x7f000001` and `017700000001` are all 127.0.0.1, and the URL parser folds
 * each of them into the dotted form - but that is the parser's behaviour rather
 * than a guarantee this file holds, and a host whose last label is a number is
 * not a name under any reading. Both checks stand.
 */
const TOP_LABEL = /^[a-z][a-z0-9-]*$/;

/**
 * Names that never denote a host on the public internet.
 *
 * Two groups, refused for the same reason. The first is reserved by the
 * standards - `localhost` is this machine, `local` is multicast DNS on the
 * local link, `home.arpa` and the rest of `arpa` are infrastructure, and
 * `test`, `invalid`, `example`, `alt` and `onion` resolve nowhere. The second
 * is the set of suffixes deployments actually use for split-horizon zones:
 * `internal` is what two large hosting providers name their private zones, and
 * `intranet`, `intra`, `private`, `corp`, `home`, `lan` and `localdomain` are
 * what a site invents when it needs one. A name under any of them is, by
 * construction, a name that means something different inside the network than
 * outside it, which is exactly the property being refused.
 */
const RESERVED_SUFFIXES: readonly string[] = [
  "localhost",
  "localdomain",
  "local",
  "internal",
  "intranet",
  "intra",
  "private",
  "corp",
  "home",
  "lan",
  "arpa",
  "test",
  "invalid",
  "example",
  "alt",
  "onion",
];

/**
 * Every address range a client id may not resolve to.
 *
 * Assembled once at module load. The runtime's own matcher is used rather than
 * a hand-written comparison because it parses both families and, for an
 * IPv4-mapped IPv6 address, applies the IPv4 rules below to the address wrapped
 * inside it - `::ffff:169.254.169.254` is the metadata service written in a way
 * a naive string check would not recognise.
 *
 * The ranges that embed an IPv4 address in an IPv6 one are blocked whole, for
 * the same reason. 6to4 carries the address in the second through fifth bytes
 * and NAT64 in the last four, so `2002:7f00:0001::` and `64:ff9b::7f00:1` are
 * both loopback with a prefix in front; refusing the prefixes removes the need
 * to unwrap them correctly.
 *
 * This overlaps the classification the pinned transport applies to the same
 * answers, and the overlap is deliberate rather than redundant. Neither is a
 * subset of the other: that one decodes the IPv4 a Teredo address obfuscates
 * and knows two ranges reserved after this list was written, while this one
 * covers the whole of the protocol-assignment range and, more importantly,
 * everything above the address layer - the scheme, the port, the reserved name
 * suffixes and the integer host forms - which the transport never sees, because
 * it judges resolved addresses and not the name they came from. This list also
 * runs before any socket exists, so a refused client id costs one lookup rather
 * than a connection. The transport is what pins; this is what this repository
 * controls.
 */
const BLOCKED_ADDRESSES = buildBlockedAddresses();

function buildBlockedAddresses(): BlockList {
  const blocked = new BlockList();

  // "This network", which includes the unspecified address 0.0.0.0. A
  // connection to it goes to the local host on most stacks.
  blocked.addSubnet("0.0.0.0", 8, "ipv4");
  blocked.addSubnet("10.0.0.0", 8, "ipv4");
  // Carrier-grade NAT. A provider's own infrastructure lives here.
  blocked.addSubnet("100.64.0.0", 10, "ipv4");
  blocked.addSubnet("127.0.0.0", 8, "ipv4");
  // Link-local, and with it 169.254.169.254: the instance metadata service of
  // every major hosting provider, unauthenticated and credential-bearing.
  blocked.addSubnet("169.254.0.0", 16, "ipv4");
  blocked.addSubnet("172.16.0.0", 12, "ipv4");
  // IETF protocol assignments, documentation ranges, the 6to4 relay anycast
  // address and the benchmarking range. None of them is a host to fetch from,
  // and several are routed somewhere surprising inside a given network.
  blocked.addSubnet("192.0.0.0", 24, "ipv4");
  blocked.addSubnet("192.0.2.0", 24, "ipv4");
  blocked.addSubnet("192.88.99.0", 24, "ipv4");
  blocked.addSubnet("192.168.0.0", 16, "ipv4");
  blocked.addSubnet("198.18.0.0", 15, "ipv4");
  blocked.addSubnet("198.51.100.0", 24, "ipv4");
  blocked.addSubnet("203.0.113.0", 24, "ipv4");
  blocked.addSubnet("224.0.0.0", 4, "ipv4");
  // Reserved, and with it the broadcast address 255.255.255.255.
  blocked.addSubnet("240.0.0.0", 4, "ipv4");

  // The unspecified address, loopback, and the deprecated IPv4-compatible
  // range that holds both.
  blocked.addSubnet("::", 96, "ipv6");
  // NAT64 and its local-use counterpart, which carry an IPv4 address.
  blocked.addSubnet("64:ff9b::", 96, "ipv6");
  blocked.addSubnet("64:ff9b:1::", 48, "ipv6");
  // Discard-only.
  blocked.addSubnet("100::", 64, "ipv6");
  // IETF protocol assignments, which contain Teredo tunnelling at 2001::/32.
  blocked.addSubnet("2001::", 23, "ipv6");
  blocked.addSubnet("2001:db8::", 32, "ipv6");
  // 6to4, which carries an IPv4 address.
  blocked.addSubnet("2002::", 16, "ipv6");
  // Documentation, and the range held back for future allocation.
  blocked.addSubnet("3fff::", 20, "ipv6");
  blocked.addSubnet("5f00::", 16, "ipv6");
  // Unique local, the IPv6 equivalent of 10/8 and 192.168/16.
  blocked.addSubnet("fc00::", 7, "ipv6");
  blocked.addSubnet("fe80::", 10, "ipv6");
  blocked.addSubnet("ff00::", 8, "ipv6");

  return blocked;
}

/**
 * Whether a client id URL may be fetched at all, judged on the text alone.
 *
 * Pure and synchronous: it resolves nothing, so it can be called wherever a URL
 * appears without turning a validation into a network round trip. It is the
 * first of two gates, and it refuses the cases no resolver is needed for.
 *
 * The port is required to be the default. A client id is a stable public HTTPS
 * URL that a person can open in a browser, and in practice that is 443; an
 * explicit port buys a legitimate client almost nothing and gives a caller a
 * port scanner. The address checks in the transport stop a connection to an
 * internal host, but they cannot stop a caller learning which ports answer on a
 * public one by timing how long the refusal takes, and a URL naming a port is
 * the shape of exactly that. Refusing it removes the whole class rather than
 * the observable, which is the sort of thing that is easy to lose later.
 */
export function isMetadataDocumentUrlAllowed(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // https only. Not because http is an internal scheme, but because everything
  // below assumes the identity the certificate proves, and because a scheme
  // list is where `file:` and `blob:` get in.
  if (parsed.protocol !== "https:") {
    return false;
  }

  // Credentials in the URL. A caller that can make this process send a
  // basic-auth header of its choosing has made it an authenticating client of
  // whatever it points at, and the header would be composed from a string the
  // caller wrote.
  if (parsed.username !== "" || parsed.password !== "") {
    return false;
  }

  if (parsed.port !== "") {
    return false;
  }

  return isPublicDnsName(parsed.hostname);
}

/**
 * Whether a host is a name that resolves on the public internet.
 *
 * Addresses are refused rather than checked, in both families. A client id that
 * names an address has skipped the resolver, and the reason to fetch a metadata
 * document at all is that the URL is an identity a person can be shown; an
 * address is not one. That also removes the case where the address rules and
 * the name rules could disagree.
 *
 * A trailing dot is refused rather than trimmed. `example.com.` and
 * `example.com` are the same host written two ways, and the client id is
 * compared as a string elsewhere - the document has to carry the URL it was
 * fetched from - so allowing both would give one client two identities. It is
 * also how a suffix check is walked past.
 */
function isPublicDnsName(hostname: string): boolean {
  // A bracketed IPv6 literal, or anything the runtime recognises as an address
  // in either family.
  if (hostname.startsWith("[") || isIP(hostname) !== 0) {
    return false;
  }

  if (hostname.length === 0 || hostname.length > MAX_HOSTNAME_LENGTH) {
    return false;
  }

  const labels = hostname.split(".");
  const top = labels.at(-1);

  // A single label is a name only the local search domain can complete, which
  // is what `localhost`, a container name and a compose service all are.
  if (labels.length < 2 || top === undefined) {
    return false;
  }

  if (!labels.every((label) => LABEL.test(label)) || !TOP_LABEL.test(top)) {
    return false;
  }

  return !RESERVED_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

/** Why the transport refused, in terms chosen here rather than by the caller. */
export type MetadataFetchCode =
  | "url-not-allowed"
  | "method-not-allowed"
  | "host-not-resolved"
  | "address-not-public"
  | "redirect-refused"
  | "too-many-redirects"
  | "response-too-large"
  | "timed-out"
  | "aborted"
  | "transport-failed";

/**
 * What every refusal says, whatever it refused.
 *
 * One message for all of them, deliberately. This error is raised while
 * answering an unauthenticated request and the discovery layer turns it into an
 * OAuth error the caller reads, so anything the message distinguishes is
 * something the caller can measure. "That address is not public" and "that host
 * does not resolve" and "that document is too large" are three different facts
 * about the inside of this deployment's network, and a caller able to tell them
 * apart can map it one client id at a time. The category is not lost - it is on
 * the error as `code` - but it stays on this side of the wire.
 */
const REFUSED_MESSAGE = "the client metadata document could not be fetched";

/**
 * A refusal, carrying its category where the log can reach it.
 *
 * `code` rather than `reason` so that the failure helper in `../logging/failure`
 * renders it beside the class name, which is the form the rest of this
 * application logs failures in. It is chosen from the closed set above and
 * never composed from the URL, the hostname or a resolved address, so it is
 * safe in a log line for the same reason a class name is: nobody interpolated
 * anything into it.
 */
export class MetadataFetchError extends Error {
  constructor(readonly code: MetadataFetchCode) {
    super(REFUSED_MESSAGE);
    this.name = "MetadataFetchError";
  }
}

/**
 * The signature the discovery plugin's transport slot takes.
 *
 * Written out rather than imported. Upstream declares it as
 * `(input: RequestInfo | URL, init?: RequestInit) => Awaitable<Response>`, and
 * `RequestInfo` - `string | URL | Request` - is not a global in this package's
 * type environment, which compiles against the Node library rather than the DOM
 * one. Expanding the alias keeps the parameter types real here instead of
 * silently widening to `any`; the two are the same shape, and the auth options
 * assigning this to the plugin option is what proves it stays so.
 */
export type MetadataResourceFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * How long the whole operation may take, in milliseconds.
 *
 * One budget for everything: resolution, connection, every redirect hop and
 * reading the body. A per-hop timeout multiplies by the hop limit and a host
 * that stalls each hop just short of it would hold a request handler for as
 * long as it liked.
 *
 * Four seconds, which is inside the five the discovery layer allows. A caller
 * is waiting on an authorization request while this runs, so the budget is what
 * a person will sit through rather than what a slow network might want. Sitting
 * inside the outer budget also makes a stall end here, with the category below,
 * rather than racing an identical timer for which of two errors is reported.
 */
const TIMEOUT_MS = 4000;

/**
 * How many redirects are followed.
 *
 * A metadata document is a static file at a fixed address, so the hops that
 * legitimately occur are an apex answering for its `www` form or a host moving
 * to a content network. Three covers that with room to spare and is not a loop.
 *
 * Note what this is not used for. The discovery layer asks for `redirect:
 * "error"` when it fetches a metadata document and refuses a document that
 * arrived through a redirect, because the document has to be served at the
 * client id URL for the URL to mean anything as an identity - an open redirect
 * on an honest client's host would otherwise let somebody else serve that
 * client's metadata. That request is honoured below. The hop loop runs for the
 * other resources this transport carries, a client's `jwks_uri` among them.
 */
const MAX_REDIRECTS = 3;

/**
 * How much body is read before the transfer is abandoned.
 *
 * 64 KiB. A metadata document is a small JSON object - a name, a handful of
 * redirect URIs, a few URLs - and a key set is a handful of keys; both are
 * single-digit kilobytes, and the discovery layer holds the document itself to
 * 5 KiB. This is the transport's own bound on everything it carries, sized so
 * that it never refuses something legitimate and still fixes what an
 * unauthenticated caller can make this process hold: the discovery layer allows
 * sixteen fetches at once, so the worst case is a megabyte.
 *
 * Applied to the bytes as they arrive, not to `content-length`. That header is
 * written by the same party that writes the body, so it is a hint about a
 * cooperative host and says nothing about a hostile one; it may be absent, it
 * may be a lie, and under chunked transfer encoding there is none to read.
 */
const MAX_RESPONSE_BYTES = 64 * 1024;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

/** Statuses whose response must not carry a body. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([
  101, 103, 204, 205, 304,
]);

/** Methods this transport will issue. It exists to read a document. */
const ALLOWED_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** Headers not carried across an origin boundary. */
const CREDENTIAL_HEADERS: readonly string[] = ["authorization", "cookie"];

/**
 * The two effects and the three bounds, as parameters.
 *
 * The seam exists because none of this can be tested otherwise: a suite that
 * exercised the address rules by resolving real names would depend on somebody
 * else's DNS zone for whether it passes, and one that exercised the redirect
 * rules would have to be handed a host that redirects into a private network.
 * Both effects are therefore reached through this record, whose defaults are
 * the real ones, and the spec supplies stubs.
 *
 * The bounds are here for the same reason rather than as configuration: a
 * timeout worth waiting for in production is one no suite should wait for. The
 * exported transport takes the constants above and nothing reads these from the
 * environment.
 */
export interface MetadataFetchDependencies {
  /**
   * A hostname to the addresses a connection to it would use.
   *
   * The operating system's resolver rather than a direct DNS query, because
   * that is what the socket will consult: a hosts file entry, a container
   * runtime's embedded resolver or a search domain can all make a name resolve
   * differently here than a nameserver would answer, and the address that must
   * be judged is the one that will be connected to.
   */
  resolve: (hostname: string) => Promise<readonly string[]>;
  /**
   * One hop. Redirects are the loop's business, never this function's.
   *
   * The default is the package's own Node transport rather than the global
   * fetch, and the difference is the whole of the rebinding argument at the top
   * of this file: it resolves once and connects to the address it approved,
   * where the global fetch resolves again inside itself and would be free to
   * reach an address nothing here ever saw. It refuses redirects by never
   * following one, which is what this loop asks of it. It applies no time or
   * size bound, which is what this module applies around it.
   *
   * Returning a response rather than a promise is allowed because that is the
   * shape the package declares. Everything here awaits it either way.
   */
  fetch: (url: string, init: RequestInit) => Promise<Response> | Response;
  timeoutMs: number;
  maxRedirects: number;
  maxResponseBytes: number;
}

/**
 * What the exported transport is built from.
 *
 * Exported so a suite can state which transport the default actually is. A seam
 * is only worth having if the thing behind it is the thing that runs.
 */
export const REAL_DEPENDENCIES: Readonly<MetadataFetchDependencies> = {
  resolve: async (hostname) => {
    const answers = await lookup(hostname, { all: true, verbatim: true });
    return answers.map((answer) => answer.address);
  },
  fetch: fetchClientMetadataResource,
  timeoutMs: TIMEOUT_MS,
  maxRedirects: MAX_REDIRECTS,
  maxResponseBytes: MAX_RESPONSE_BYTES,
};

/**
 * Builds the transport. The exported one below is this with its defaults.
 */
export function createGuardedMetadataFetch(
  overrides: Partial<MetadataFetchDependencies> = {},
): MetadataResourceFetch {
  // Field by field rather than a spread: a spread of a partial record carries
  // a key that was written as `undefined`, and a bound silently becoming
  // undefined is the one way this could stop bounding anything.
  const dependencies: MetadataFetchDependencies = {
    resolve: overrides.resolve ?? REAL_DEPENDENCIES.resolve,
    fetch: overrides.fetch ?? REAL_DEPENDENCIES.fetch,
    timeoutMs: overrides.timeoutMs ?? REAL_DEPENDENCIES.timeoutMs,
    maxRedirects: overrides.maxRedirects ?? REAL_DEPENDENCIES.maxRedirects,
    maxResponseBytes:
      overrides.maxResponseBytes ?? REAL_DEPENDENCIES.maxResponseBytes,
  };

  return async (input, init) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();

    if (!ALLOWED_METHODS.has(method)) {
      throw new MetadataFetchError("method-not-allowed");
    }

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const redirect =
      init?.redirect ?? (input instanceof Request ? input.redirect : "follow");
    const caller =
      init?.signal ?? (input instanceof Request ? input.signal : null);

    // One timer for the whole operation. `AbortSignal.any` keeps the caller's
    // own cancellation working alongside it - the discovery layer passes a
    // signal of its own - and the timeout signal is kept separately so a
    // refusal can say which of the two fired.
    const deadline = AbortSignal.timeout(dependencies.timeoutMs);
    const signal =
      caller === null ? deadline : AbortSignal.any([deadline, caller]);

    return await untilDeadline(signal, deadline, async () =>
      followHops(target(input), {
        dependencies,
        headers,
        method,
        redirect,
        signal,
      }),
    );
  };
}

/**
 * The transport the auth options hand to the discovery plugin.
 */
export const guardedMetadataFetch: MetadataResourceFetch =
  createGuardedMetadataFetch();

/**
 * What the caller asked be done with a redirect, spelled out for the same
 * reason the transport signature above is: the alias the runtime declares this
 * under is not a global in this package's type environment.
 */
type RedirectMode = "error" | "follow" | "manual";

interface HopContext {
  dependencies: MetadataFetchDependencies;
  headers: Headers;
  method: string;
  redirect: RedirectMode;
  signal: AbortSignal;
}

/**
 * Walks the redirect chain, checking every hop as though it were the first.
 *
 * This is the whole reason redirects are not left to the runtime. A check run
 * once on the URL the caller wrote is satisfied by a hostname that resolves
 * publicly and answers `302 Location: http://169.254.169.254/`; whatever
 * follows that redirect is the thing that has to refuse it, and if the runtime
 * follows it there is nothing in between. So every hop goes back through both
 * gates - the text of the URL and the addresses it resolves to - and the
 * runtime is told to hand back the redirect rather than act on it.
 */
async function followHops(url: string, context: HopContext): Promise<Response> {
  const { dependencies } = context;
  let current = url;
  let headers = context.headers;

  for (let hop = 0; ; hop += 1) {
    if (!isMetadataDocumentUrlAllowed(current)) {
      throw new MetadataFetchError("url-not-allowed");
    }

    await refuseUnlessPublic(new URL(current).hostname, dependencies);

    let response: Response;
    try {
      response = await dependencies.fetch(current, {
        headers,
        method: context.method,
        redirect: "manual",
        signal: context.signal,
      });
    } catch (cause) {
      throw transportFailure(cause, context.signal);
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      return await bounded(response, hop, dependencies.maxResponseBytes);
    }

    // `manual` is what a caller asking for the redirect itself wants back, and
    // `error` is the discovery layer refusing to accept a document from
    // anywhere but the client id URL. Neither is followed.
    if (context.redirect === "manual") {
      return await bounded(response, hop, dependencies.maxResponseBytes);
    }
    if (context.redirect === "error") {
      await discard(response);
      throw new MetadataFetchError("redirect-refused");
    }

    const location = response.headers.get("location");
    await discard(response);

    if (location === null || location === "") {
      throw new MetadataFetchError("transport-failed");
    }
    if (hop >= dependencies.maxRedirects) {
      throw new MetadataFetchError("too-many-redirects");
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new MetadataFetchError("url-not-allowed");
    }

    // A credential belongs to the host it was issued for. A hop to another
    // origin is a different host, and one that asked for the header.
    if (next.origin !== new URL(current).origin) {
      headers = withoutCredentials(headers);
    }
    current = next.href;
  }
}

/**
 * Resolves the hostname and refuses unless every answer is publicly routable.
 *
 * Every answer, not the first. A name is free to carry several A and AAAA
 * records, the resolver may return them in any order and rotate it between
 * calls, and the connection is made to whichever the stack picks. Judging one
 * of them would leave which addresses this server may be pointed at up to a
 * round-robin.
 */
async function refuseUnlessPublic(
  hostname: string,
  dependencies: MetadataFetchDependencies,
): Promise<void> {
  let addresses: readonly string[];
  try {
    addresses = await dependencies.resolve(hostname);
  } catch {
    throw new MetadataFetchError("host-not-resolved");
  }

  if (addresses.length === 0) {
    throw new MetadataFetchError("host-not-resolved");
  }

  if (!addresses.every(isPublicAddress)) {
    throw new MetadataFetchError("address-not-public");
  }
}

/**
 * Whether one address is outside every range above.
 *
 * Anything the runtime cannot parse is refused rather than allowed through. A
 * resolver that returns something unrecognised - a scoped link-local address
 * carrying its interface, a form a future release adds - is a case where the
 * conservative answer is the one that does not connect.
 */
function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  return !BLOCKED_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Reads the body up to the limit and rebuilds the response around it.
 *
 * Reading rather than streaming on to the caller is what makes the limit
 * enforceable here: a stream handed over unread is a limit the consumer has to
 * remember to apply. The transfer is cancelled at the moment the total passes
 * the bound, so an endless body costs one chunk more than the bound rather than
 * all of it.
 *
 * `content-length` is rewritten to what was actually read and `content-encoding`
 * is dropped, because the runtime has already decompressed the stream; leaving
 * either in place would describe the rebuilt body with the original's numbers.
 */
async function bounded(
  response: Response,
  hops: number,
  maxResponseBytes: number,
): Promise<Response> {
  const body = NULL_BODY_STATUSES.has(response.status)
    ? null
    : await readBounded(response, maxResponseBytes);

  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  if (body === null) {
    headers.delete("content-length");
  } else {
    headers.set("content-length", String(body.byteLength));
  }

  const rebuilt = new Response(body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });

  // A rebuilt response reports `redirected: false` whatever it took to get
  // here, and a consumer that refuses a redirected document - the discovery
  // layer does - would be reading a fact this function had erased.
  if (hops > 0) {
    Object.defineProperty(rebuilt, "redirected", { value: true });
  }

  return rebuilt;
}

async function readBounded(
  response: Response,
  maxResponseBytes: number,
): Promise<Uint8Array | null> {
  const stream = response.body;
  if (stream === null) {
    return null;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxResponseBytes) {
        throw new MetadataFetchError("response-too-large");
      }
      chunks.push(value);
    }
  } catch (cause) {
    await reader.cancel().catch(() => {
      // The connection is being abandoned either way.
    });
    throw cause instanceof MetadataFetchError
      ? cause
      : new MetadataFetchError("transport-failed");
  }

  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/**
 * Holds the operation to the deadline whatever the transport does with it.
 *
 * The signal is handed to every hop and a well-behaved runtime aborts on it,
 * but a budget that only holds when the layer below cooperates is not a budget.
 * Racing the work against the signal makes the bound this function's own: the
 * caller is answered when the timer fires, and a transport still holding a
 * socket at that point is no longer something anyone is waiting for.
 */
async function untilDeadline<T>(
  signal: AbortSignal,
  deadline: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) {
    throw new MetadataFetchError(deadline.aborted ? "timed-out" : "aborted");
  }

  let fail: (error: Error) => void = () => {
    // Replaced synchronously by the executor below.
  };
  const aborted = new Promise<never>((_resolve, reject) => {
    fail = reject;
  });
  const onAbort = (): void => {
    fail(new MetadataFetchError(deadline.aborted ? "timed-out" : "aborted"));
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    return await Promise.race([work(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** The URL a call names, whichever of the three forms it used to name it. */
function target(input: string | URL | Request): string {
  if (typeof input === "string") {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/**
 * A failed hop, told apart from a cancellation.
 *
 * The runtime rejects with an abort error when the signal fires, and reporting
 * that as a transport failure would hide a timeout behind "the host did not
 * answer". Which signal fired is settled by the signal itself rather than by
 * reading the error, because the error is composed elsewhere.
 */
function transportFailure(cause: unknown, signal: AbortSignal): Error {
  if (cause instanceof MetadataFetchError) {
    return cause;
  }
  return new MetadataFetchError(
    signal.aborted ? "timed-out" : "transport-failed",
  );
}

/**
 * Releases a response nothing will read.
 *
 * The headers stay readable, so a redirect's location can still be taken from a
 * response whose body has been cancelled. An unread body holds the connection
 * until the collector reaches it, and this runs on an unauthenticated request.
 */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The connection is being abandoned either way.
  }
}

function withoutCredentials(headers: Headers): Headers {
  const carried = new Headers(headers);
  for (const name of CREDENTIAL_HEADERS) {
    carried.delete(name);
  }
  return carried;
}
