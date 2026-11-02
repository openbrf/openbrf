import type { PluginProcessing } from "@openbrf/plugin-sdk";
import { describe, expect, it } from "vite-plus/test";

import { declaredProcessing } from "./plugin-processing";

/**
 * The categories of data subjects a plugin's row in the record of processing
 * activities is seeded with (ADR 0035, "Former residents").
 */

const PROCESSING: PluginProcessing = {
  purpose: { sv: "Låna ut platser.", en: "Lend spaces." },
  legalBasis: "contract",
  retention: { sv: "Två år.", en: "Two years." },
  dataSubjects: ["members", "residents"],
};

describe("declaredProcessing", () => {
  it("records the categories the plugin declares, in the core's words", () => {
    expect(declaredProcessing(PROCESSING, "sv").dataSubjectCategories).toEqual([
      "member",
      "resident",
    ]);
    expect(
      declaredProcessing(
        { ...PROCESSING, dataSubjects: ["formerResidents"] },
        "sv",
      ).dataSubjectCategories,
    ).toEqual(["formerResident"]);
  });

  it("adds former residents for a plugin that keeps records about a person", () => {
    expect(
      declaredProcessing(PROCESSING, "en", [{ collection: "claims" }])
        .dataSubjectCategories,
    ).toEqual(["member", "resident", "formerResident"]);
  });

  it("names former residents once where the plugin declares them itself", () => {
    expect(
      declaredProcessing(
        { ...PROCESSING, dataSubjects: ["formerResidents", "residents"] },
        "sv",
        [{ collection: "claims" }],
      ).dataSubjectCategories,
    ).toEqual(["formerResident", "resident"]);
  });

  it("adds nothing for a plugin that keeps no records about a person", () => {
    expect(
      declaredProcessing(PROCESSING, "sv", []).dataSubjectCategories,
    ).toEqual(["member", "resident"]);
  });

  it("adds board members and people outside the association for the classes the resident routes serve (ADR 0053)", () => {
    expect(
      declaredProcessing(PROCESSING, "sv", [], ["board"]).dataSubjectCategories,
    ).toEqual(["member", "resident", "boardMember"]);
    expect(
      declaredProcessing(
        PROCESSING,
        "sv",
        [{ collection: "claims" }],
        ["propertyManager", "board", "pluginAccess"],
      ).dataSubjectCategories,
    ).toEqual([
      "member",
      "resident",
      "formerResident",
      "boardMember",
      "external",
    ]);
  });
});
