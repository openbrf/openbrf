import "reflect-metadata";
import { createRequire } from "node:module";
import type { PluginModuleFactory } from "@openbrf/plugin-sdk";
import { describe, expect, it } from "vitest";
import { context, fakeHost, STORGATAN_3, type FakeHost } from "./fake-host.ts";
import { sourceInputSchema, sourceOutputSchema } from "./source-schema.ts";

/**
 * The addon as it ships: the built bundle, loaded with `require` as the host
 * loads it, handed a host object, and called as digital signage calls it.
 */
const { createPlugin } = createRequire(import.meta.url)(
  "../dist/server.cjs",
) as { createPlugin: PluginModuleFactory };

function contributed(fake: FakeHost) {
  const [only] = fake.contributed;
  if (only === undefined) {
    throw new Error("The addon contributed nothing.");
  }
  return only;
}

function screen(
  overrides: Partial<{
    addressId: string | null;
    placement: "inside" | "outside";
    locale: "sv" | "en";
  }> = {},
) {
  return sourceInputSchema.parse({
    screen: {
      id: "screen-1",
      addressId: STORGATAN_3.id,
      placement: "inside",
      locale: "en",
      ...overrides,
    },
  });
}

async function answer(fake: FakeHost, input: unknown, signal?: AbortSignal) {
  const value = await contributed(fake).contribution.handler(
    input,
    context(signal),
  );
  // What the host does before digital signage sees the answer: one string
  // over its limit, or one key the point does not name, and there are no
  // slides at all.
  return sourceOutputSchema.parse(value);
}

describe("the contribution", () => {
  it("is made once, to digital signage's source point, with its title and description in the addon's own files", async () => {
    const fake = fakeHost();
    const module = await createPlugin(fake.host);

    expect(module.module.name).toBe("SignageRulesModule");
    expect(fake.contributed).toHaveLength(1);
    const { target, contribution } = contributed(fake);
    expect(target).toEqual({ plugin: "signage", point: "source" });
    expect(contribution.titleKey).toBe("source.title");
    expect(contribution.descriptionKey).toBe("source.description");
  });

  it("contributes nothing on an instance without extension points", async () => {
    const fake = fakeHost({ withExtensions: false });
    await createPlugin(fake.host);

    expect(fake.contributed).toEqual([]);
    expect(fake.logged).toEqual([
      "This instance has no extension points, so the addon contributes nothing.",
    ]);
  });

  it("reads nothing before it is called", async () => {
    const fake = fakeHost();
    await createPlugin(fake.host);

    expect(fake.addressReads).toBe(0);
  });
});

describe("the slides", () => {
  it("are the rules, headed with the screen's address, and the opening hours, within the point's limits", async () => {
    const fake = fakeHost();
    await createPlugin(fake.host);

    expect(await answer(fake, screen())).toEqual({
      slides: [
        {
          kind: "text",
          heading: "Laundry room, Storgatan 3",
          body: [
            "Book your time on the board in the laundry room or on the association's website.",
            "Clean the machines, the drum and the floor after use.",
            "Empty the lint filter of the tumble dryer.",
            "A time not taken within 30 minutes of its start is free for anyone.",
          ],
        },
        {
          kind: "table",
          heading: "Opening hours",
          columns: ["Days", "Time"],
          rows: [
            ["Monday to Friday", "07:00–22:00"],
            ["Saturday and Sunday", "09:00–20:00"],
          ],
        },
      ],
    });
  });

  it("are in the screen's language", async () => {
    const fake = fakeHost();
    await createPlugin(fake.host);

    const { slides } = await answer(fake, screen({ locale: "sv" }));
    expect(slides.map((slide) => slide.heading)).toEqual([
      "Tvättstugan, Storgatan 3",
      "Öppettider",
    ]);
  });

  it("carry no address where the board gave none, or gave one the association no longer has", async () => {
    const fake = fakeHost();
    await createPlugin(fake.host);

    for (const addressId of [null, "address-sold"]) {
      const { slides } = await answer(fake, screen({ addressId }));
      expect(slides[0]?.heading).toBe("Laundry room");
    }
  });

  it("fall back to the plain heading for an address the heading has no room for, in both languages", async () => {
    const fake = fakeHost();
    await createPlugin(fake.host);

    // The longest street and number the association's address form accepts.
    fake.addresses = [
      { ...STORGATAN_3, street: "S".repeat(200), number: "1".repeat(20) },
    ];
    for (const [locale, heading] of [
      ["en", "Laundry room"],
      ["sv", "Tvättstugan"],
    ] as const) {
      const { slides } = await answer(fake, screen({ locale }));
      expect(slides[0]?.heading).toBe(heading);
    }

    // One that still fits keeps its address.
    fake.addresses = [{ ...STORGATAN_3, street: "S".repeat(180), number: "1" }];
    const { slides } = await answer(fake, screen());
    expect(slides[0]?.heading).toBe(`Laundry room, ${"S".repeat(180)} 1`);
  });

  it("read the addresses on each call, so a change reaches the screen at its next fetch", async () => {
    const fake = fakeHost();
    await createPlugin(fake.host);

    await answer(fake, screen());
    fake.addresses = [{ ...STORGATAN_3, number: "3 A" }];
    const { slides } = await answer(fake, screen());

    expect(fake.addressReads).toBe(2);
    expect(slides[0]?.heading).toBe("Laundry room, Storgatan 3 A");
  });

  it("are none for a screen visible from outside the building, and nothing is read for it", async () => {
    const fake = fakeHost();
    await createPlugin(fake.host);

    expect(await answer(fake, screen({ placement: "outside" }))).toEqual({
      slides: [],
    });
    expect(fake.addressReads).toBe(0);
  });

  it("accept a field the module adds to the input later", async () => {
    const fake = fakeHost();
    await createPlugin(fake.host);

    const input = screen();
    const { slides } = await answer(fake, {
      ...input,
      screen: { ...input.screen, orientation: 90 },
      layout: "portrait",
    });
    expect(slides).toHaveLength(2);
  });

  it("are not answered once the module has stopped waiting", async () => {
    const fake = fakeHost();
    await createPlugin(fake.host);

    const controller = new AbortController();
    controller.abort(new Error("timed out"));
    await expect(answer(fake, screen(), controller.signal)).rejects.toThrow(
      "timed out",
    );
  });
});
