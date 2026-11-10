import { BlockList, isIP } from "node:net";

/**
 * The addresses in `addresses` that a TRUSTED_PROXIES value does not name.
 *
 * Read as the application reads the variable: a comma-separated list of
 * addresses and CIDR ranges, IPv4 or IPv6, a bare address being a range of one.
 * An entry that is neither is refused rather than skipped, so a typo in an env
 * file fails the run that has it instead of quietly naming less than it says.
 */
export function untrustedAddresses(
  addresses: readonly string[],
  trustedProxies: string,
): string[] {
  const trusted = new BlockList();
  for (const entry of trustedProxies.split(",")) {
    const range = entry.trim();
    if (range === "") {
      continue;
    }
    const slash = range.indexOf("/");
    const address = slash === -1 ? range : range.slice(0, slash);
    const prefix = slash === -1 ? undefined : range.slice(slash + 1);
    const family = isIP(address);
    const bits = family === 4 ? 32 : 128;
    const length = prefix === undefined ? bits : Number(prefix);
    if (
      family === 0 ||
      (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) ||
      length > bits
    ) {
      throw new Error(`TRUSTED_PROXIES: "${range}" is not an address or range`);
    }
    trusted.addSubnet(address, length, family === 4 ? "ipv4" : "ipv6");
  }

  return addresses.filter((address) => {
    const family = isIP(address);
    return (
      family === 0 || !trusted.check(address, family === 4 ? "ipv4" : "ipv6")
    );
  });
}
