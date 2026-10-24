import { Logger } from "@nestjs/common";
import {
  EXTENSION_MAX_OUTPUT_LENGTH,
  type ExtensionContext,
  type PluginExtensionDeclaration,
  type PluginExtensionPointDeclaration,
} from "@openbrf/plugin-sdk";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";
import { z } from "zod";

import { extensionHostOf } from "./extension-call";
import {
  ExtensionDefinitionError,
  PluginExtensionsService,
} from "./plugin-extensions.service";

/**
 * Carrying a call from a host plugin to an addon (ADR 0030).
 *
 * The properties that matter are the ones that keep the two plugins apart:
 * only data crosses, in the shapes the host plugin's schemas name, and
 * nothing the addon does is thrown at the host plugin, so one broken source
 * cannot take a screen's whole rotation down with it.
 */

const POINT: PluginExtensionPointDeclaration = {
  id: "source",
  version: 1,
  personalData: ["name"],
};

const EXTENSION: PluginExtensionDeclaration = {
  plugin: "signage",
  point: "source",
  version: 1,
  personalData: ["name"],
};

const input = z.strictObject({ screen: z.string() });
const output = z.strictObject({
  items: z.array(z.strictObject({ title: z.string() })),
});

type Handler = (input: unknown, context: ExtensionContext) => Promise<unknown>;

let serving: Set<string>;
let service: PluginExtensionsService;
let errors: ReturnType<typeof vi.spyOn>;

function setUp(handler: Handler, options: { timeoutMs?: number } = {}): void {
  service.define("signage", POINT, { input, output, ...options });
  service.contribute("signage-residents", EXTENSION, {
    titleKey: "source.title",
    handler,
  });
}

beforeEach(() => {
  serving = new Set(["signage", "signage-residents"]);
  service = new PluginExtensionsService();
  service.bindLiveness((pluginId) => serving.has(pluginId));
  errors = vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a call that is answered", () => {
  it("hands the host plugin the addon's answer", async () => {
    setUp(async () => ({ items: [{ title: "Andersson" }] }));

    await expect(
      service.invoke("signage", "source", "signage-residents", {
        screen: "entrance-a",
      }),
    ).resolves.toEqual({
      ok: true,
      value: { items: [{ title: "Andersson" }] },
    });
  });

  it("tells the addon which point it answers, and gives it a signal", async () => {
    const handler = vi.fn<Handler>(async () => ({ items: [] }));
    setUp(handler);

    await service.invoke("signage", "source", "signage-residents", {
      screen: "entrance-a",
    });

    const [, context] = handler.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      hostPlugin: "signage",
      point: "source",
      version: 1,
    });
    expect(context?.signal.aborted).toBe(false);
    expect(context?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("runs the handler as the addon's answer to the host plugin, and only the handler", async () => {
    // Read after an await, as a read deep in the addon's own code would be.
    const seen: (string | null)[] = [];
    setUp(async () => {
      await Promise.resolve();
      seen.push(
        extensionHostOf("signage-residents"),
        extensionHostOf("signage"),
        extensionHostOf("weather"),
      );
      return { items: [] };
    });

    await service.invoke("signage", "source", "signage-residents", {
      screen: "entrance-a",
    });

    expect(seen).toEqual(["signage", null, null]);
    // The host plugin's own code, after the call, is outside it.
    expect(extensionHostOf("signage-residents")).toBeNull();
  });

  it("ends the scope when the handler settles, for work it left running", async () => {
    let later: Promise<string | null> = Promise.resolve(null);
    let finish = (): void => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    setUp(async () => {
      // Started inside the call, read after the answer has been given.
      later = gate.then(() => extensionHostOf("signage-residents"));
      return { items: [] };
    });

    await service.invoke("signage", "source", "signage-residents", {
      screen: "entrance-a",
    });
    finish();

    await expect(later).resolves.toBeNull();
  });

  it("keeps two calls in flight at once apart, each with its own host plugin", async () => {
    serving.add("lobby");
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const handler = async (): Promise<unknown> => {
      // Both calls wait here together, so a scope one of them set on
      // something shared would be what the other one reads.
      entered += 1;
      if (entered === 2) {
        release();
      }
      await held;
      return { items: [{ title: extensionHostOf("signage-residents") ?? "" }] };
    };
    service.define("signage", POINT, { input, output });
    service.define("lobby", POINT, { input, output });
    service.contribute("signage-residents", EXTENSION, {
      titleKey: "source.title",
      handler,
    });
    service.contribute(
      "signage-residents",
      { ...EXTENSION, plugin: "lobby" },
      { titleKey: "source.title", handler },
    );

    const calls = await Promise.all(
      ["signage", "lobby"].map((hostPlugin) =>
        service.invoke(hostPlugin, "source", "signage-residents", {
          screen: "entrance-a",
        }),
      ),
    );

    expect(entered).toBe(2);
    expect(calls).toEqual([
      { ok: true, value: { items: [{ title: "signage" }] } },
      { ok: true, value: { items: [{ title: "lobby" }] } },
    ]);
  });

  it("copies the input, so the addon holds nothing of the host plugin's", async () => {
    const sent = { screen: "entrance-a" };
    let received: unknown;
    setUp(async (value) => {
      received = value;
      return { items: [] };
    });

    await service.invoke("signage", "source", "signage-residents", sent);

    expect(received).toEqual(sent);
    expect(received).not.toBe(sent);
  });

  it("copies the answer, so the host plugin holds nothing of the addon's", async () => {
    // A getter is the addon's code, and would run again each time the host
    // plugin read the field. What arrives is its value, read once.
    let reads = 0;
    const item = {
      get title() {
        reads += 1;
        return "Andersson";
      },
    };
    setUp(async () => ({ items: [item] }));

    const result = await service.invoke(
      "signage",
      "source",
      "signage-residents",
      { screen: "entrance-a" },
    );

    expect(result).toEqual({
      ok: true,
      value: { items: [{ title: "Andersson" }] },
    });
    expect(reads).toBe(1);
    // A plain value now, not an accessor.
    expect(
      result.ok &&
        Object.getOwnPropertyDescriptor(
          (result.value as { items: object[] }).items[0],
          "title",
        ),
    ).toMatchObject({ value: "Andersson", writable: true });
  });
});

describe("what the addon does wrong is answered, never thrown", () => {
  it("answers not-serving for an addon that is switched off", async () => {
    setUp(async () => ({ items: [] }));
    serving.delete("signage-residents");

    await expect(
      service.invoke("signage", "source", "signage-residents", {
        screen: "a",
      }),
    ).resolves.toEqual({ ok: false, reason: "not-serving" });
    expect(service.list("signage", "source")).toEqual([]);
  });

  it("answers not-serving for an addon with no contribution here", async () => {
    service.define("signage", POINT, { input, output });

    await expect(
      service.invoke("signage", "source", "weather", { screen: "a" }),
    ).resolves.toEqual({ ok: false, reason: "not-serving" });
  });

  it("answers failed, and logs the class but never the message", async () => {
    setUp(async () => {
      throw new RangeError("Anna Andersson, 19800101-1234");
    });

    await expect(
      service.invoke("signage", "source", "signage-residents", {
        screen: "a",
      }),
    ).resolves.toEqual({ ok: false, reason: "failed" });
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain("RangeError");
    expect(logged).toContain("signage-residents");
    expect(logged).not.toContain("Andersson");
  });

  it("answers output-invalid for a field the schema does not name", async () => {
    // The field an addon could use to hand over something nobody consented
    // to.
    setUp(async () => ({
      items: [{ title: "Andersson", email: "anna@exempel.se" }],
    }));

    await expect(
      service.invoke("signage", "source", "signage-residents", {
        screen: "a",
      }),
    ).resolves.toEqual({ ok: false, reason: "output-invalid" });
    expect(JSON.stringify(errors.mock.calls)).not.toContain("anna@");
  });

  it("answers output-invalid for a value JSON cannot carry", async () => {
    setUp(async () => ({ items: [{ title: 1n }] }));

    await expect(
      service.invoke("signage", "source", "signage-residents", {
        screen: "a",
      }),
    ).resolves.toEqual({ ok: false, reason: "output-invalid" });
  });

  it("logs a refused path by the names the schema declares, never a key from the answer", async () => {
    // A refinement of the host plugin's that reports where it failed by what
    // the addon answered, which is how a resident's name, or a line break
    // forging a second entry, would reach the log.
    const keyed = output.superRefine((value, ctx) => {
      for (const [index, item] of value.items.entries()) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, item.title],
          message: item.title,
        });
      }
    });
    service.define("signage", POINT, { input, output: keyed });
    service.contribute("signage-residents", EXTENSION, {
      titleKey: "source.title",
      handler: async () => ({ items: [{ title: "Name\nFORGED" }] }),
    });

    await expect(
      service.invoke("signage", "source", "signage-residents", {
        screen: "a",
      }),
    ).resolves.toEqual({ ok: false, reason: "output-invalid" });
    const logged = errors.mock.calls.flat().join("\n");
    expect(logged).toContain("items.0.*");
    expect(logged).not.toContain("FORGED");
    expect(logged).not.toContain("\n");
  });

  it("answers output-invalid for an answer too long to parse", async () => {
    setUp(async () => ({
      items: [{ title: "x".repeat(EXTENSION_MAX_OUTPUT_LENGTH) }],
    }));
    const parse = vi.spyOn(JSON, "parse");

    await expect(
      service.invoke("signage", "source", "signage-residents", {
        screen: "a",
      }),
    ).resolves.toEqual({ ok: false, reason: "output-invalid" });
    // Refused on its length alone: the text was never parsed.
    expect(
      parse.mock.calls.some(
        ([text]) => text.length > EXTENSION_MAX_OUTPUT_LENGTH,
      ),
    ).toBe(false);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("xxx");
  });

  it("answers timed-out, aborts the addon's signal and drops a late answer", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    setUp(
      async (_input, context) => {
        signal = context.signal;
        return new Promise(() => {});
      },
      { timeoutMs: 50 },
    );

    const pending = service.invoke("signage", "source", "signage-residents", {
      screen: "a",
    });
    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toEqual({ ok: false, reason: "timed-out" });
    expect(signal?.aborted).toBe(true);
  });
});

describe("what the host plugin does wrong is thrown", () => {
  it("refuses an input its own schema refuses, before the addon runs", async () => {
    const handler = vi.fn<Handler>(async () => ({ items: [] }));
    setUp(handler);

    await expect(
      service.invoke("signage", "source", "signage-residents", {
        screen: "a",
        person: "Anna",
      }),
    ).rejects.toThrow(TypeError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a point it has not defined", async () => {
    await expect(
      service.invoke("signage", "source", "signage-residents", {}),
    ).rejects.toThrow(/without defining it/);
    expect(() => service.list("signage", "source")).toThrow(
      /without defining it/,
    );
  });

  it("rejects with the reason of a signal it aborted itself", async () => {
    const controller = new AbortController();
    setUp(async (_input, context) => {
      controller.abort(new Error("the screen went away"));
      return new Promise((resolve) => {
        context.signal.addEventListener("abort", () => {
          resolve({ items: [] });
        });
      });
    });

    await expect(
      service.invoke(
        "signage",
        "source",
        "signage-residents",
        { screen: "a" },
        controller.signal,
      ),
    ).rejects.toThrow("the screen went away");
  });
});

describe("list", () => {
  it("lists the serving contributions with their keys in the addon's namespace", () => {
    setUp(async () => ({ items: [] }));
    service.contribute("signage-weather", EXTENSION, {
      titleKey: "title",
      descriptionKey: "description",
      handler: async () => ({ items: [] }),
    });
    serving.add("signage-weather");

    expect(service.list("signage", "source")).toEqual([
      {
        addon: "signage-residents",
        titleKey: "plugin-signage-residents:source.title",
        descriptionKey: null,
      },
      {
        addon: "signage-weather",
        titleKey: "plugin-signage-weather:title",
        descriptionKey: "plugin-signage-weather:description",
      },
    ]);
  });

  it("lists nothing once the host plugin stops serving", () => {
    setUp(async () => ({ items: [] }));
    serving.delete("signage");

    expect(service.list("signage", "source")).toEqual([]);
  });

  it("forgets both sides of a plugin that is unregistered", async () => {
    setUp(async () => ({ items: [] }));
    service.unregisterPlugin("signage-residents");

    expect(service.list("signage", "source")).toEqual([]);
    service.unregisterPlugin("signage");
    expect(() => service.list("signage", "source")).toThrow();
  });
});

describe("define and contribute refuse what cannot be carried", () => {
  it.each([
    [
      "an input that strips unknown keys",
      { input: z.object({ a: z.string() }), output },
    ],
    [
      "a nested object that strips unknown keys",
      {
        input,
        output: z.strictObject({ item: z.object({ title: z.string() }) }),
      },
    ],
    ["an output that is not an object", { input, output: z.array(z.string()) }],
    [
      "a schema from another validator",
      {
        input: {
          "~standard": {
            version: 1,
            vendor: "other",
            validate: () => ({ value: {} }),
          },
        },
        output,
      },
    ],
    ["a time out over the limit", { input, output, timeoutMs: 15_001 }],
    ["a fractional time out", { input, output, timeoutMs: 1.5 }],
  ])("refuses %s", (_what, definition) => {
    expect(() => {
      service.define("signage", POINT, definition);
    }).toThrow(ExtensionDefinitionError);
  });

  /*
   * Each carries a key the schema does not name, and an action's input may
   * still hold one, so the rule is the point's own: `{ metadata: z.unknown() }`
   * would carry an email address as readily as a title.
   */
  it.each([
    ["unknown", z.unknown()],
    ["any", z.any()],
    ["a record", z.record(z.string(), z.string())],
    ["a partial record", z.partialRecord(z.enum(["a"]), z.string())],
    ["a catchall", z.strictObject({ title: z.string() }).catchall(z.string())],
    ["an array of unknown", z.array(z.unknown())],
    ["a tuple with an open rest", z.tuple([z.string()], z.unknown())],
    ["a union with unknown", z.union([z.string(), z.unknown()])],
    ["unknown with a default", z.unknown().default(null)],
  ])("refuses %s anywhere in either schema", (_what, open: z.ZodType) => {
    for (const definition of [
      { input: z.strictObject({ screen: z.string(), metadata: open }), output },
      { input, output: z.strictObject({ metadata: open }) },
      {
        input,
        output: z.strictObject({
          items: z.array(z.strictObject({ metadata: open })),
        }),
      },
    ]) {
      expect(() => {
        new PluginExtensionsService().define("signage", POINT, definition);
      }).toThrow(ExtensionDefinitionError);
    }
  });

  it("accepts a schema whose every key is named, however deep", () => {
    const deep = z.strictObject({
      screen: z.string(),
      at: z.iso.datetime().optional(),
      layout: z.enum(["full", "half"]).nullable(),
      slots: z.tuple([z.number().int(), z.number().int()]),
      filters: z.array(
        z.discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("tag"), tag: z.string() }),
          z.strictObject({
            kind: z.literal("range"),
            range: z.strictObject({ from: z.number(), to: z.number() }),
          }),
        ]),
      ),
    });

    expect(() => {
      service.define("signage", POINT, { input: deep, output: deep });
    }).not.toThrow();
  });

  it("never carries a key the schema does not name through a nested unknown", () => {
    // The definition is refused, so the addon's email address has no point to
    // cross: the plugin stops serving with extension-refused instead.
    expect(() => {
      service.define("signage", POINT, {
        input,
        output: z.strictObject({ metadata: z.unknown() }),
      });
    }).toThrow(ExtensionDefinitionError);
  });

  it("refuses a point defined twice", () => {
    service.define("signage", POINT, { input, output });
    expect(() => {
      service.define("signage", POINT, { input, output });
    }).toThrow(ExtensionDefinitionError);
  });

  it.each([
    ["a second contribution", { titleKey: "title", handler: async () => ({}) }],
    [
      "a key in another namespace",
      { titleKey: "common:save", handler: async () => ({}) },
    ],
    ["no handler", { titleKey: "title" }],
  ])("refuses %s", (_what, contribution) => {
    service.contribute("signage-residents", EXTENSION, {
      titleKey: "title",
      handler: async () => ({}),
    });
    const addon =
      _what === "a second contribution"
        ? "signage-residents"
        : "signage-weather";

    expect(() => {
      service.contribute(addon, EXTENSION, contribution);
    }).toThrow(ExtensionDefinitionError);
  });
});
