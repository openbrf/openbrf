import { describe, expect, it } from "vite-plus/test";

import { untrustedAddresses } from "./trusted-proxies";

describe("untrustedAddresses", () => {
  const STACK = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";

  it("passes a gateway inside any of the ranges named", () => {
    expect(
      untrustedAddresses(["10.128.10.1", "172.18.0.1", "192.168.65.1"], STACK),
    ).toEqual([]);
  });

  it("returns a gateway outside them, as a daemon with pools of its own gives", () => {
    expect(
      untrustedAddresses(
        ["10.128.10.1"],
        // What stack.env named before 10.0.0.0/8 was added.
        "172.16.0.0/12,192.168.0.0/16",
      ),
    ).toEqual(["10.128.10.1"]);
  });

  it("never trusts the addresses the tests give themselves", () => {
    expect(
      untrustedAddresses(["100.64.0.1", "100.127.255.254"], STACK),
    ).toEqual(["100.64.0.1", "100.127.255.254"]);
  });

  it("reads a bare address, spaces and IPv6 as the application does", () => {
    expect(
      untrustedAddresses(
        ["203.0.113.7", "2001:db8::1", "2001:db9::1"],
        " 203.0.113.7 , 2001:db8::/32 ",
      ),
    ).toEqual(["2001:db9::1"]);
  });

  it("returns what is not an address at all", () => {
    expect(untrustedAddresses(["", "gateway"], STACK)).toEqual(["", "gateway"]);
  });

  it.each(["10.0.0.0/33", "10.0.0.0/8/9", "10.0.0.0/", "10.0.0/8", "proxy"])(
    "refuses %s rather than naming less than it says",
    (entry) => {
      expect(() => untrustedAddresses([], entry)).toThrow(entry);
    },
  );
});
