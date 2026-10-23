import { describe, expect, it } from "vite-plus/test";

import {
  PERMISSION_REGISTER_ACCESS,
  PLUGIN_PERMISSIONS,
  readsRegister,
  REGISTER_READING_PERMISSIONS,
} from "./permissions.ts";

describe("which permissions read the register", () => {
  it("classifies every permission, and only permissions", () => {
    // The record is typed against the list, so this fails at compile time too;
    // it is here so that the rules which keep a plugin with a device route or
    // a website block away from the register cannot quietly miss a permission
    // added later, however the type is loosened.
    expect(Object.keys(PERMISSION_REGISTER_ACCESS).sort()).toEqual(
      [...PLUGIN_PERMISSIONS].sort(),
    );
  });

  it("names the permissions that return a person's name", () => {
    expect([...REGISTER_READING_PERMISSIONS]).toEqual([
      "addressBook:read",
      "addressBook:readContact",
      "finances:read",
    ]);
  });

  it("answers for a list of permissions", () => {
    expect(readsRegister([])).toBe(false);
    expect(readsRegister(["mail:send", "finances:recordDelivery"])).toBe(false);
    expect(readsRegister(["mail:send", "finances:read"])).toBe(true);
    expect(readsRegister(["something:later"])).toBe(false);
  });
});
