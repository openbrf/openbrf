import { isLoopbackHost } from "./loopback-host.ts";

/**
 * The WHATWG URL parser, which the browser and Node both provide. This package
 * compiles against the language alone, so the part of it read here is stated.
 */
interface ParsedUrl {
  readonly href: string;
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly host: string;
  readonly hostname: string;
}
declare const URL: new (input: string) => ParsedUrl;

/**
 * A reverse-domain scheme: two or more DNS labels joined by dots, such as
 * `se.exempel.app` (RFC 8252 7.1). A scheme with no dot in it is not one, and
 * that is what keeps out every scheme a browser runs or hands to a program of
 * its own choosing - `javascript`, `data`, `file`, `mailto`.
 */
const REVERSE_DOMAIN_SCHEME =
  /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Where an authorization code may be sent. One rule, for the instance that
 * registers a client and for the consent screen that sends the member's
 * browser on with the code, so that neither accepts what the other refuses.
 *
 * Three kinds of address, the ones RFC 8252 names for a client that is a web
 * application or an app on the member's own device:
 *
 * - https, anywhere but this machine;
 * - plain http on this machine, for an app listening on a loopback port
 *   (RFC 8252 7.3);
 * - an app's own scheme, written as a reversed domain name with no host after
 *   it - `se.exempel.app:/callback` (RFC 8252 7.1).
 *
 * And never one with credentials or a fragment in it.
 *
 * Every other scheme is refused. The consent screen navigates to this address
 * with the code in it, so a script or data address would run in this
 * application's origin, and plain http elsewhere would send the code across a
 * network in clear text. An app's own scheme is handed to the device's
 * operating system and never loaded in this origin, and the code it carries is
 * worth nothing without the verifier the app kept (PKCE, which every client
 * here must use).
 *
 * A client that identifies itself by the address of its metadata document
 * meets one more rule on the server, which this one cannot state because it
 * sees no client: its https addresses must be on that document's origin.
 */
export function isAcceptableRedirectUri(value: string): boolean {
  let url: ParsedUrl;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "" || value.includes("#")) {
    return false;
  }
  if (url.protocol === "https:") {
    return !namesThisMachine(url.hostname);
  }
  if (url.protocol === "http:") {
    return isLoopbackHost(url.hostname);
  }
  return isAppScheme(url);
}

/**
 * Whether an https host is this machine, in any of the spellings the OAuth
 * provider refuses there: an app on this machine listens on plain http, and
 * nothing on it holds a certificate for these names (RFC 8252 8.3). Every name
 * under `localhost` counts, as RFC 6761 6.3 reserves them for this machine and
 * the sign-in library's own loopback test takes them. Wider than the hosts
 * plain http is taken on, which are the three exact ones.
 */
function namesThisMachine(hostname: string): boolean {
  return (
    isLoopbackHost(hostname) ||
    /(^|\.)localhost\.*$/i.test(hostname) ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname)
  );
}

/**
 * Whether an address is in an app's own scheme rather than on the web: a
 * reverse-domain scheme followed by a path and no host (`scheme:/path`, not
 * `scheme://host/path`).
 */
function isAppScheme(url: ParsedUrl): boolean {
  const scheme = url.protocol.slice(0, -1);
  const rest = url.href.slice(url.protocol.length);
  return (
    url.host === "" &&
    rest.startsWith("/") &&
    !rest.startsWith("//") &&
    REVERSE_DOMAIN_SCHEME.test(scheme)
  );
}
