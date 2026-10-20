import { describe, expect, it, vi } from "vite-plus/test";

import type { AuditLogService } from "../audit/audit-log.service";
import {
  checkedPluginAuditEntry,
  PluginAuditService,
} from "./plugin-audit.service";

/**
 * What a plugin may write to the audit log through `host.audit` (ADR 0035).
 *
 * The log is append-only and exempt from every purge, so an entry is held to
 * bounds that keep it a record of what the plugin did rather than a copy of
 * what it read.
 */

/** A personal identity number that passes the calendar and the Luhn check. */
const IDENTITY_NUMBER = "19121212-1212";

function refusal(input: unknown): RangeError {
  try {
    checkedPluginAuditEntry("signage", input);
  } catch (cause) {
    expect(cause).toBeInstanceOf(RangeError);
    return cause as RangeError;
  }
  throw new Error("The entry was expected to be refused.");
}

describe("checkedPluginAuditEntry", () => {
  it("accepts an event, a target and a few values", () => {
    const entry = {
      event: "screen.residents-enabled",
      targetKind: "screen",
      targetId: "clx1screen",
      detail: { enabled: true, entrance: "Kungsgatan 4", screens: 2 },
    };

    expect(checkedPluginAuditEntry("signage", entry)).toEqual(entry);
  });

  it.each([
    ["an uppercase letter", "Screen.enabled"],
    ["a space", "screen enabled"],
    ["an underscore", "screen_enabled"],
    ["a leading digit", "1screen"],
    ["nothing", ""],
    ["65 characters", `a${"b".repeat(64)}`],
  ])("refuses an event with %s", (_, event) => {
    refusal({ event });
  });

  it("refuses more than eight values, and a value longer than 200 characters", () => {
    const nine = Object.fromEntries(
      Array.from({ length: 9 }, (_, index) => [`key${String(index)}`, index]),
    );

    refusal({ event: "screen.enabled", detail: nine });
    refusal({ event: "screen.enabled", detail: { note: "x".repeat(201) } });
  });

  it("refuses a value that is neither text, a number nor a yes or no", () => {
    refusal({ event: "screen.enabled", detail: { person: { id: "p1" } } });
    refusal({ event: "screen.enabled", detail: { names: ["Anna"] } });
  });

  it("refuses a field the entry does not define", () => {
    // A plugin naming a person in a field of its own would otherwise reach the
    // log beside the actor.
    refusal({ event: "screen.enabled", targetPersonId: "person-1" });
  });

  it("refuses a personal identity number anywhere, and names the field rather than the value", () => {
    const inDetail = refusal({
      event: "screen.enabled",
      detail: { who: IDENTITY_NUMBER },
    });
    const inTarget = refusal({
      event: "screen.enabled",
      targetId: IDENTITY_NUMBER,
    });
    const asNumber = refusal({
      event: "screen.enabled",
      detail: { who: 191212121212 },
    });

    expect(inDetail.message).toContain("detail.who");
    expect(inDetail.message).not.toContain("1212");
    expect(inTarget.message).toContain("targetId");
    expect(asNumber.message).toContain("detail.who");
  });

  it("leaves a refused value out of the message", () => {
    const refused = refusal({ event: "anna@example.test" });

    expect(refused.message).not.toContain("anna");
  });
});

describe("PluginAuditService", () => {
  it("writes PLUGIN_RECORDED on the plugin channel with the plugin as its target", async () => {
    const record = vi.fn(async () => undefined);
    const service = new PluginAuditService({
      record,
    } as unknown as AuditLogService);

    await service.record(
      "signage",
      { personId: "person-board", clientId: null, clientHost: null },
      {
        event: "screen.residents-enabled",
        targetKind: "screen",
        targetId: "screen-1",
        detail: { enabled: true },
      },
    );

    expect(record).toHaveBeenCalledWith({
      action: "PLUGIN_RECORDED",
      channel: "PLUGIN",
      actorPersonId: "person-board",
      clientId: null,
      clientHost: null,
      targetKind: "plugin",
      targetId: "signage",
      context: {
        event: "screen.residents-enabled",
        targetKind: "screen",
        targetId: "screen-1",
        detail: { enabled: true },
      },
    });
  });

  it("writes nothing when the entry is refused", async () => {
    const record = vi.fn(async () => undefined);
    const service = new PluginAuditService({
      record,
    } as unknown as AuditLogService);

    await expect(
      service.record("signage", null, { event: "Not an event" }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(record).not.toHaveBeenCalled();
  });
});
