/**
 * Whether a host names this machine: the one place a connection may go
 * unencrypted, because it never crosses a network.
 *
 * Both IPv6 forms, because a URL parser always returns the address bracketed
 * and an SMTP host is written as the operator typed it.
 */
export function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    host === "::1"
  );
}
