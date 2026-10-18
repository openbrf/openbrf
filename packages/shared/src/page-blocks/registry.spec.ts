import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { PAGE_CONTENT_LIMITS } from "../page-content-limits.ts";
import {
  CORE_BLOCK_TYPE_PATTERN,
  defineBlock,
  isNamespacedBlockType,
} from "./definition.ts";
import { CORE_BLOCKS, createBlockRegistry, PAGE_BLOCKS } from "./registry.ts";
import { wordsOnly } from "./text-runs.ts";

/**
 * The registry is where a block type is known or not, so these hold it to the
 * two promises the rest of the platform builds on: a type is declared in one
 * place and every reader agrees about it, and a block nobody here can read is
 * either dropped or kept exactly - never half-understood.
 */

/** A plugin's block, as a page holds it once its plugin is gone. */
const POLL = {
  type: "example-plugin/poll",
  question: "Ska vi måla om trapphuset?",
  options: [{ label: "Ja" }, { label: "Nej" }],
};

/** A plugin block type that is registered, for the cases that need one. */
interface CounterBlock {
  type: "example-plugin/counter";
  start: number;
}

const counterBlock = defineBlock<CounterBlock>()({
  type: "example-plugin/counter",
  schema: (zod) =>
    zod.strictObject({
      type: zod.literal("example-plugin/counter"),
      start: zod.int(),
    }),
  read: (stored) =>
    typeof stored["start"] === "number"
      ? { type: "example-plugin/counter", start: stored["start"] }
      : null,
  text: () => wordsOnly(""),
  editor: {
    label: "plugin-example-plugin.counter",
    insert: null,
    icon: "facts",
    category: "association",
    nestable: false,
    create: () => ({ type: "example-plugin/counter", start: 0 }),
  },
});

describe("the core's block types", () => {
  it("are each declared once, under a bare type id", () => {
    const types = CORE_BLOCKS.map((definition) => definition.type);
    expect(new Set(types).size).toBe(types.length);
    for (const type of types) {
      expect(type).toMatch(CORE_BLOCK_TYPE_PATTERN);
      expect(isNamespacedBlockType(type)).toBe(false);
    }
  });

  it("start every block the editor adds as one the reader keeps", () => {
    // A block the board has just added and filled in nothing on is either
    // read back as itself, or is one the editor would not send yet.
    for (const definition of CORE_BLOCKS) {
      const created = definition.editor.create();
      expect(created.type).toBe(definition.type);
      if (PAGE_BLOCKS.ready(created)) {
        expect(PAGE_BLOCKS.read(created)).toEqual(created);
      }
    }
  });

  it("offer only blocks that name a label to add them with", () => {
    const offered = CORE_BLOCKS.filter(
      (definition) => definition.editor.insert !== null,
    ).map((definition) => definition.type);
    expect(offered).toEqual([
      "paragraph",
      "heading",
      "image",
      "eventCalendar",
      "documentList",
      "boardRoster",
      "associationFacts",
      "faq",
    ]);
  });

  it("let only the prose and the picture sit inside a column", () => {
    expect(
      CORE_BLOCKS.filter((definition) => definition.editor.nestable).map(
        (definition) => definition.type,
      ),
    ).toEqual(["paragraph", "heading", "image"]);
  });
});

describe("a registry", () => {
  it("refuses a type two definitions claim", () => {
    expect(() => createBlockRegistry([...CORE_BLOCKS, CORE_BLOCKS[0]])).toThrow(
      /registered twice/,
    );
  });

  it("refuses a type id of neither shape", () => {
    for (const type of ["Paragraph", "two words", "a/b/c", "-x/y", "x/"]) {
      expect(() =>
        createBlockRegistry([{ ...CORE_BLOCKS[0], type } as never]),
      ).toThrow(/not a block type id/);
    }
  });

  it("takes a plugin's namespaced block beside the core's", () => {
    const registry = createBlockRegistry([...CORE_BLOCKS, counterBlock]);
    expect(registry.read({ type: "example-plugin/counter", start: 4 })).toEqual(
      {
        type: "example-plugin/counter",
        start: 4,
      },
    );
    // A registered type is read by its own definition, so content that
    // definition does not recognise is dropped rather than kept as though
    // nobody knew the type.
    expect(
      registry.read({ type: "example-plugin/counter", start: "fyra" }),
    ).toBeNull();
  });
});

describe("a block of a namespaced type nobody registered", () => {
  it("is read exactly as it was stored", () => {
    expect(PAGE_BLOCKS.read(POLL)).toEqual(POLL);
  });

  it("is a copy, not the stored value itself", () => {
    const read = PAGE_BLOCKS.read(POLL);
    expect(read).not.toBe(POLL);
  });

  it("is dropped once it is larger than the write path allows", () => {
    const large = {
      type: "example-plugin/poll",
      question: "x".repeat(PAGE_CONTENT_LIMITS.unregisteredBlock),
    };
    expect(PAGE_BLOCKS.read(large)).toBeNull();
  });

  it("is stored by the write path as it was sent", () => {
    expect(PAGE_BLOCKS.normalize(POLL)).toEqual(POLL);
  });

  it("is always ready to send, so a save does not leave it out", () => {
    expect(PAGE_BLOCKS.ready(POLL)).toBe(true);
  });

  it("has every string on it scanned, as words and as an address", () => {
    const text = PAGE_BLOCKS.text({
      type: "example-plugin/poll",
      question: "Vem bor här?",
      options: [{ label: "Den på %31" }],
    });
    // Every value the plugin might print or link to, and never the type id.
    expect(text.words).toBe("Vem bor här? Den på %31");
    expect(text.addresses).toContain("Den på 1");
    expect(text.addresses.join(" ")).not.toContain("example-plugin");
  });
});

describe("a block of a namespaced type nobody registered, nested deep", () => {
  /** A string inside `depth` arrays, as plain JSON within the size limit. */
  function nested(depth: number) {
    let data: unknown = "abc";
    for (let level = 0; level < depth; level += 1) {
      data = [data];
    }
    return { type: "example-plugin/poll", data };
  }

  // 4,900 arrays is under 10,000 characters of JSON, and deeper than a
  // recursive walk survives on the stack.
  const deep = nested(4900);

  it("is within the size limit, so only its depth refuses it", () => {
    expect(JSON.stringify(deep).length).toBeLessThanOrEqual(
      PAGE_CONTENT_LIMITS.unregisteredBlock,
    );
  });

  it("is scanned without throwing", () => {
    expect(PAGE_BLOCKS.text(deep).words).toBe("abc");
  });

  it("is refused by the write path as a validation result", () => {
    const result = z.array(PAGE_BLOCKS.schema(z)).safeParse([deep]);
    expect(result.success).toBe(false);
  });

  it("is dropped on read", () => {
    expect(PAGE_BLOCKS.read(deep)).toBeNull();
  });

  it("is kept at the deepest nesting the write path allows", () => {
    // The block itself is the first level and the string is not a level.
    const deepest = nested(PAGE_CONTENT_LIMITS.unregisteredBlockDepth - 1);
    expect(PAGE_BLOCKS.read(deepest)).toEqual(deepest);
    expect(
      PAGE_BLOCKS.read(nested(PAGE_CONTENT_LIMITS.unregisteredBlockDepth)),
    ).toBeNull();
    expect(z.array(PAGE_BLOCKS.schema(z)).safeParse([deepest]).success).toBe(
      true,
    );
  });
});

describe("a bare type nobody registered", () => {
  it("is dropped, as a block from a newer core is", () => {
    expect(PAGE_BLOCKS.read({ type: "embed", src: "https://x.invalid" })).toBe(
      null,
    );
  });
});

describe("the write schema", () => {
  const blocks = z.array(PAGE_BLOCKS.schema(z));

  it("accepts a block of a namespaced type nobody registered", () => {
    expect(blocks.parse([POLL])).toEqual([POLL]);
  });

  it("refuses one larger than it may be", () => {
    const large = {
      type: "example-plugin/poll",
      question: "x".repeat(PAGE_CONTENT_LIMITS.unregisteredBlock),
    };
    expect(blocks.safeParse([large]).success).toBe(false);
  });

  it("refuses a bare type nobody registered", () => {
    expect(
      blocks.safeParse([{ type: "embed", src: "https://x.invalid" }]).success,
    ).toBe(false);
  });

  it("names the field a registered block was refused for", () => {
    // The path into the block is how the editor tells the board which link
    // it will not publish. A union reporting the failure at the block would
    // lose it.
    const result = blocks.safeParse([
      { type: "paragraph", runs: [{ text: "Hej", link: "javascript:x()" }] },
    ]);
    expect(result.success).toBe(false);
    // The pattern and the publishability check both refuse it, and both say
    // where.
    const paths = new Set(
      result.error?.issues.map((issue) => issue.path.join(".")),
    );
    expect([...paths]).toEqual(["0.runs.0.link"]);
  });

  it("names a run that is too long by its own path", () => {
    const result = blocks.safeParse([
      {
        type: "heading",
        level: 2,
        runs: [{ text: "x".repeat(PAGE_CONTENT_LIMITS.runText + 1) }],
      },
    ]);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      [0, "runs", 0, "text"],
    ]);
  });

  it("does not take a registered plugin block's bad content as unregistered", () => {
    const registry = createBlockRegistry([...CORE_BLOCKS, counterBlock]);
    const schema = z.array(registry.schema(z));
    expect(
      schema.safeParse([{ type: "example-plugin/counter", start: "fyra" }])
        .success,
    ).toBe(false);
    expect(
      schema.parse([{ type: "example-plugin/counter", start: 4 }]),
    ).toEqual([{ type: "example-plugin/counter", start: 4 }]);
  });

  it("has a strict half for a caller that may declare every key", () => {
    const registered = z.array(PAGE_BLOCKS.registeredSchema(z));
    expect(registered.safeParse([POLL]).success).toBe(false);
    expect(
      registered.parse([{ type: "paragraph", runs: [{ text: "Hej" }] }]),
    ).toEqual([{ type: "paragraph", runs: [{ text: "Hej" }] }]);
  });
});
