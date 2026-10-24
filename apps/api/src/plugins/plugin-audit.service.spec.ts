import {
  PLUGIN_AUDIT_LIMITS,
  PluginAuditRateError,
  PluginHostUnavailableError,
} from "@openbrf/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { AuditLogService } from "../audit/audit-log.service";
import {
  checkedPluginAuditEntry,
  type PluginAuditActor,
  PluginAuditService,
} from "./plugin-audit.service";
import type { PluginLoaderService } from "./plugin-loader.service";

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
      detail: { enabled: true, who: IDENTITY_NUMBER },
    });
    const inTarget = refusal({
      event: "screen.enabled",
      targetId: IDENTITY_NUMBER,
    });
    const asNumber = refusal({
      event: "screen.enabled",
      detail: { who: 191212121212 },
    });
    const inEvent = refusal({ event: `screen.${IDENTITY_NUMBER}` });
    const inTargetKind = refusal({
      event: "screen.enabled",
      targetKind: `person.${IDENTITY_NUMBER}`,
    });

    expect(inDetail.message).toContain("detail[1]");
    expect(inTarget.message).toContain("targetId");
    expect(asNumber.message).toContain("detail[0]");
    expect(inEvent.message).toContain("event");
    expect(inTargetKind.message).toContain("targetKind");
    for (const refused of [inDetail, inTarget, asNumber, inEvent, inTargetKind])
      expect(refused.message).not.toContain("1212");
  });

  it.each([
    ["a personal identity number", { [IDENTITY_NUMBER]: true }],
    ["one after a letter", { x191212121212: true }],
    ["one with a value the host refuses", { x191212121212: { id: "p1" } }],
    ["a name", { "Anna Svensson, 1203": true }],
    ["65 characters", { [`a${"b".repeat(64)}`]: true }],
  ])(
    "refuses a detail key holding %s and names it by its place",
    (_, detail) => {
      const refused = refusal({ event: "screen.enabled", detail });

      expect(refused.message).toContain("detail[0]");
      expect(refused.message).not.toContain("1212");
      expect(refused.message).not.toContain("Anna");
      expect(refused.message).not.toContain("bbbb");
    },
  );

  it("leaves a refused value out of the message", () => {
    const refused = refusal({ event: "anna@example.test" });

    expect(refused.message).not.toContain("anna");
  });

  /**
   * A key the host cannot place among the keys it read names no place at all.
   * The label is the one thing a refusal says about a key, so a key that is
   * not where the host first looked must not fall back to its own text.
   */
  describe("a detail key the host cannot place", () => {
    it("refuses a symbol key as detail[?], whatever it describes", () => {
      const refused = refusal({
        event: "screen.enabled",
        detail: { enabled: true, [Symbol(`Anna ${IDENTITY_NUMBER}`)]: true },
      });

      expect(refused.message).toContain("detail[?]");
      expect(refused.message).not.toContain("Anna");
      expect(refused.message).not.toContain("1212");
    });

    it("refuses a key a Proxy adds after the host read the keys as detail[?]", () => {
      let reads = 0;
      const hidden = `Anna Svensson ${IDENTITY_NUMBER}`;
      const detail = new Proxy<Record<string, unknown>>(
        { enabled: true, [hidden]: true },
        {
          // The keys the host reads first, then the ones zod reads.
          ownKeys: () => (++reads === 1 ? ["enabled"] : ["enabled", hidden]),
          getOwnPropertyDescriptor: (target, key) => ({
            value: target[key as string],
            enumerable: true,
            configurable: true,
            writable: true,
          }),
        },
      );

      const refused = refusal({ event: "screen.enabled", detail });

      expect(reads).toBeGreaterThan(1);
      expect(refused.message).toContain("detail[?]");
      expect(refused.message).not.toContain("Anna");
      expect(refused.message).not.toContain("1212");
    });

    it("leaves a non-enumerable key out of the entry it writes", () => {
      const detail = { enabled: true };
      Object.defineProperty(detail, "x191212121212", {
        value: "Anna Svensson",
        enumerable: false,
      });

      expect(
        checkedPluginAuditEntry("signage", { event: "screen.enabled", detail }),
      ).toEqual({ event: "screen.enabled", detail: { enabled: true } });
    });
  });
});

/** The service, over an audit log and a loader that only record their calls. */
function auditService(): {
  service: PluginAuditService;
  record: ReturnType<typeof vi.fn>;
  refuse: ReturnType<typeof vi.fn>;
} {
  const record = vi.fn(async () => undefined);
  const refuse = vi.fn();
  const service = new PluginAuditService(
    { record } as unknown as AuditLogService,
    { refuse } as unknown as PluginLoaderService,
  );
  return { service, record, refuse };
}

describe("PluginAuditService", () => {
  it("writes PLUGIN_RECORDED on the plugin channel with the plugin as its target", async () => {
    const { service, record } = auditService();

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

  it.each([
    ["an event the host refuses", { event: "Not an event" }],
    [
      "a personal identity number in a detail key",
      { event: "screen.enabled", detail: { [IDENTITY_NUMBER]: true } },
    ],
    [
      "a personal identity number in the event",
      { event: `screen.${IDENTITY_NUMBER}` },
    ],
  ])("writes nothing when the entry holds %s", async (_, entry) => {
    const { service, record } = auditService();

    await expect(service.record("signage", null, entry)).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(record).not.toHaveBeenCalled();
  });

  /**
   * How many entries a plugin may write with no request (P3-3 of the ADR 0035
   * review). An entry needs no permission and no purge removes it, so the
   * budget is what keeps a job writing in a loop from growing the log for good.
   */
  describe("the budget for entries with no request", () => {
    const PER_MINUTE = PLUGIN_AUDIT_LIMITS.perMinute;
    const ENTRY = { event: "screen.enabled" };

    afterEach(() => {
      vi.useRealTimers();
    });

    async function spend(
      service: PluginAuditService,
      count: number,
      pluginId = "signage",
    ): Promise<void> {
      for (let index = 0; index < count; index += 1) {
        await service.record(pluginId, null, ENTRY);
      }
    }

    it("refuses the entry past the budget, writes nothing for it and stops the plugin with a finding", async () => {
      vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z") });
      const { service, record, refuse } = auditService();
      await spend(service, PER_MINUTE);
      expect(refuse).not.toHaveBeenCalled();

      await expect(service.record("signage", null, ENTRY)).rejects.toThrow(
        PluginHostUnavailableError,
      );

      expect(record).toHaveBeenCalledTimes(PER_MINUTE);
      expect(refuse).toHaveBeenCalledExactlyOnceWith(
        "signage",
        "audit-rate-exceeded",
        { perMinute: PER_MINUTE },
      );
    });

    it("reports a stopped plugin once, however often it tries again", async () => {
      vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z") });
      const { service, record, refuse } = auditService();
      await spend(service, PER_MINUTE);
      await expect(spend(service, 1)).rejects.toThrow();

      // Even once the budget has refilled: the board was told it was
      // stopped, and it stays stopped until the instance restarts.
      vi.advanceTimersByTime(60_000);
      await expect(spend(service, 1)).rejects.toThrow(
        PluginHostUnavailableError,
      );

      expect(refuse).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledTimes(PER_MINUTE);
    });

    it("refills, so a plugin writing at its rate is never stopped", async () => {
      vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z") });
      const { service, record, refuse } = auditService();
      await spend(service, PER_MINUTE);

      // Half a minute gives back half the budget, and ten minutes at the rate
      // spend no more than comes back.
      vi.advanceTimersByTime(30_000);
      await spend(service, PER_MINUTE / 2);
      for (let minute = 0; minute < 10; minute += 1) {
        vi.advanceTimersByTime(60_000);
        await spend(service, PER_MINUTE);
      }

      expect(refuse).not.toHaveBeenCalled();
      expect(record).toHaveBeenCalledTimes(PER_MINUTE * 11 + PER_MINUTE / 2);
    });

    it("keeps one plugin's budget apart from another's", async () => {
      vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z") });
      const { service, refuse } = auditService();
      await spend(service, PER_MINUTE, "signage");

      await spend(service, PER_MINUTE, "laundry");

      expect(refuse).not.toHaveBeenCalled();
    });

    it("spends nothing on an entry it refuses", async () => {
      vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z") });
      const { service, refuse } = auditService();
      for (let index = 0; index < PER_MINUTE; index += 1) {
        await expect(
          service.record("signage", null, { event: "Not an event" }),
        ).rejects.toBeInstanceOf(RangeError);
      }

      await spend(service, PER_MINUTE);

      expect(refuse).not.toHaveBeenCalled();
    });
  });
  /**
   * How many entries a plugin may write on a person's requests. That person
   * spends the budget, so going past it refuses their entry and leaves the
   * plugin running: stopping it would let any member stop it for everyone by
   * making it audit them fast enough.
   */
  describe("the budget for entries on a person's request", () => {
    const PER_PERSON = PLUGIN_AUDIT_LIMITS.perPersonPerMinute;
    const ENTRY = { event: "screen.enabled" };

    function actor(personId: string): PluginAuditActor {
      return { personId, clientId: null, clientHost: null };
    }

    async function spend(
      service: PluginAuditService,
      count: number,
      personId: string,
      pluginId = "signage",
    ): Promise<void> {
      for (let index = 0; index < count; index += 1) {
        await service.record(pluginId, actor(personId), ENTRY);
      }
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    it("refuses the person's entry past the budget, writes nothing for it and leaves the plugin running", async () => {
      vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z") });
      const { service, record, refuse } = auditService();
      await spend(service, PER_PERSON, "person-anna");

      const refused = await service
        .record("signage", actor("person-anna"), ENTRY)
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(refused).toBeInstanceOf(PluginAuditRateError);
      expect((refused as Error).message).not.toContain("person-anna");
      expect(record).toHaveBeenCalledTimes(PER_PERSON);
      expect(refuse).not.toHaveBeenCalled();
    });

    it("never stops the plugin, however long one person keeps at it", async () => {
      vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z") });
      const { service, refuse } = auditService();

      for (
        let attempt = 0;
        attempt < PLUGIN_AUDIT_LIMITS.perMinute * 2;
        attempt += 1
      ) {
        await service
          .record("signage", actor("person-anna"), ENTRY)
          .catch((error: unknown) => {
            expect(error).toBeInstanceOf(PluginAuditRateError);
          });
      }

      expect(refuse).not.toHaveBeenCalled();
    });

    it("gives each person a budget of their own", async () => {
      vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z") });
      const { service, record, refuse } = auditService();
      const people = Math.ceil(PLUGIN_AUDIT_LIMITS.perMinute / PER_PERSON) + 1;

      for (let person = 0; person < people; person += 1) {
        await spend(service, PER_PERSON, `person-${String(person)}`);
      }

      expect(record).toHaveBeenCalledTimes(PER_PERSON * people);
      expect(refuse).not.toHaveBeenCalled();
    });

    it("keeps a person's budget with one plugin apart from their budget with another", async () => {
      vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z") });
      const { service, record } = auditService();
      await spend(service, PER_PERSON, "person-anna", "signage");

      await expect(
        spend(service, PER_PERSON, "person-anna", "laundry"),
      ).resolves.toBeUndefined();

      // Resolving is not enough: a branch that skipped the second plugin's
      // writes would resolve too, so the entries themselves are counted.
      const written = (pluginId: string): unknown[] =>
        record.mock.calls
          .map(([entry]) => entry as { targetId: string })
          .filter((entry) => entry.targetId === pluginId);
      expect(written("signage")).toHaveLength(PER_PERSON);
      expect(written("laundry")).toHaveLength(PER_PERSON);
      for (const entry of written("laundry")) {
        expect(entry).toMatchObject({
          action: "PLUGIN_RECORDED",
          channel: "PLUGIN",
          actorPersonId: "person-anna",
          targetKind: "plugin",
          targetId: "laundry",
        });
      }
    });

    it("keeps people's entries out of the budget that stops the plugin", async () => {
      vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z") });
      const { service, refuse } = auditService();
      await spend(service, PER_PERSON, "person-anna");

      await expect(
        (async () => {
          for (
            let index = 0;
            index < PLUGIN_AUDIT_LIMITS.perMinute;
            index += 1
          ) {
            await service.record("signage", null, ENTRY);
          }
        })(),
      ).resolves.toBeUndefined();
      expect(refuse).not.toHaveBeenCalled();
    });

    it("refills the person's budget", async () => {
      vi.useFakeTimers({ now: new Date("2026-10-23T10:00:00Z") });
      const { service } = auditService();
      await spend(service, PER_PERSON, "person-anna");
      await expect(spend(service, 1, "person-anna")).rejects.toThrow(
        PluginAuditRateError,
      );

      vi.advanceTimersByTime(60_000);

      await expect(
        spend(service, PER_PERSON, "person-anna"),
      ).resolves.toBeUndefined();
    });
  });
});
