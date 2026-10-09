import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import { BlockList, isIP } from "node:net";

/**
 * Which addresses this process may open a connection to on somebody's word.
 *
 * Three places hand this process an address to dial that whoever runs the
 * instance did not write: a connected app's metadata document URL, which an
 * unauthenticated caller chooses, and the SMS gateway and the SMTP server, which
 * an administrator enters in the settings. The process holding the member
 * register runs in a network beside a database, a job queue and a mail relay
 * that are not reachable from outside it, and a hosting provider's instance
 * metadata service answers on a fixed link-local address from inside every
 * container, returning credentials to anything that asks. Any of the three
 * pointed at one of those makes this server the thing that reaches it.
 *
 * So the rule is one module, read by all three. A server whoever runs the
 * instance named in its environment is not judged by it: the operator chose
 * that host, and a relay on the Compose network is the ordinary case there.
 *
 * Judging an address is half the job. The other half is connecting to the
 * address that was judged: a name resolved once to be checked and again to be
 * connected to can answer differently the second time, which is the shape an
 * attacker with an authoritative nameserver arranges. {@link pinnedLookup} is
 * that second half for anything built on `node:net`.
 */

/**
 * Every address range a connection on somebody's word may not reach.
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
  // address and the benchmarking range. None of them is a host to connect to,
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
 * Whether one address is outside every range above.
 *
 * Anything the runtime cannot parse is refused rather than allowed through. A
 * resolver that returns something unrecognised - a scoped link-local address
 * carrying its interface, a form a future release adds - is a case where the
 * conservative answer is the one that does not connect.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  return !BLOCKED_ADDRESSES.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** One answer the resolver gave, as a socket would be opened to it. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * A hostname to the addresses a connection to it would use.
 *
 * The operating system's resolver rather than a direct DNS query, because that
 * is what a socket consults: a hosts file entry, a container runtime's embedded
 * resolver or a search domain can all make a name resolve differently here
 * than a nameserver would answer, and the address that must be judged is the
 * one that will be connected to.
 */
export type ResolveAddresses = (
  hostname: string,
) => Promise<readonly ResolvedAddress[]>;

export const resolveAddresses: ResolveAddresses = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family === 6 ? 6 : 4,
  }));
};

/** Why a host was refused, in terms chosen here rather than by the caller. */
export type OutboundAddressCode = "host-not-resolved" | "address-not-public";

/**
 * A host this process will not connect to.
 *
 * One message for both codes. The caller who named the host is the party the
 * check holds back, and "that name does not resolve" and "that name resolves
 * inside this network" are two different facts about the network: told apart,
 * they map it one name at a time. The code stays on this side, for the log.
 */
export class OutboundAddressError extends Error {
  constructor(readonly code: OutboundAddressCode) {
    super("the host is not a public address this instance may connect to");
    this.name = "OutboundAddressError";
  }
}

/**
 * Resolves a host and returns its addresses, refusing unless every one of them
 * is publicly routable.
 *
 * Every answer, not the first. A name is free to carry several A and AAAA
 * records, the resolver may return them in any order and rotate it between
 * calls, and the connection is made to whichever the stack picks. Judging one
 * of them would leave where this server may be pointed up to a round-robin.
 *
 * An address written as the host is judged as it stands, without a lookup, and
 * so is an IPv6 one in the brackets a URL writes it in.
 *
 * `allowPrivate` is the operator's word that the network is theirs (a gateway
 * or a relay on the association's own LAN). The host is still resolved, so
 * that what a caller connects to is still the answer this returned.
 */
export async function resolvePublicAddresses(
  host: string,
  options: { allowPrivate: boolean; resolve?: ResolveAddresses },
): Promise<readonly ResolvedAddress[]> {
  const hostname =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  let addresses: readonly ResolvedAddress[];
  const family = isIP(hostname);
  if (family !== 0) {
    addresses = [{ address: hostname, family: family === 6 ? 6 : 4 }];
  } else {
    try {
      addresses = await (options.resolve ?? resolveAddresses)(hostname);
    } catch {
      throw new OutboundAddressError("host-not-resolved");
    }
  }

  if (addresses.length === 0) {
    throw new OutboundAddressError("host-not-resolved");
  }
  if (
    !options.allowPrivate &&
    !addresses.every((answer) => isPublicAddress(answer.address))
  ) {
    throw new OutboundAddressError("address-not-public");
  }
  return addresses;
}

/**
 * A `lookup` for `node:net`, `node:tls`, `node:http` and `node:https` that
 * answers with addresses already judged, and never asks the resolver again.
 *
 * This is the pin. The socket is opened to one of these addresses whatever the
 * name it was asked for resolves to by then, while the hostname stays what the
 * Host header carries, what TLS presents as the server name and what the
 * certificate is checked against.
 *
 * Both shapes of answer, because the runtime asks for both: one address when a
 * connection tries a single one, and all of them when it races the families.
 */
export function pinnedLookup(
  addresses: readonly ResolvedAddress[],
): LookupFunction {
  return (_hostname, options, callback) => {
    const family =
      options.family === "IPv4"
        ? 4
        : options.family === "IPv6"
          ? 6
          : options.family;
    const wanted =
      family === 4 || family === 6
        ? addresses.filter((answer) => answer.family === family)
        : addresses;
    const first = wanted[0];
    if (first === undefined) {
      callback(new OutboundAddressError("host-not-resolved"), "", 0);
      return;
    }
    if (options.all === true) {
      callback(null, [...wanted]);
      return;
    }
    callback(null, first.address, first.family);
  };
}
