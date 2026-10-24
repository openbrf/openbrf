import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import "../i18n";
import type {
  ProcessingActivityView,
  ProcessingRecord,
} from "../api/data-protection";
import { ProcessingActivitiesPanel } from "./ProcessingActivitiesPanel";

/**
 * What a plugin's row in the record of processing activities says about the
 * personal data it handles (ADR 0035).
 *
 * A plugin that reads the address book keeps an open row whatever it declares,
 * because the row is what a person objects to. One installed from outside the
 * catalog, or published before the package check, may declare no categories,
 * and an empty list beside "Personal data" would read as a processing of none.
 */

const PLUGIN_ROW: ProcessingActivityView = {
  activityId: "activity-signage",
  name: "Skärmar i trapphusen",
  purpose: "Visa boende på skärmar",
  legalBasis: "LEGITIMATE_INTEREST",
  legalBasisNote: null,
  dataSubjectCategories: ["resident"],
  personalDataCategories: [],
  recipients: null,
  thirdCountryTransfer: false,
  thirdCountrySafeguards: null,
  retention: "",
  securityMeasures: null,
  source: "PLUGIN",
  sourceKey: "plugin:signage",
  endedAt: null,
  seeded: true,
  revision: 1,
};

function record(activity: ProcessingActivityView): ProcessingRecord {
  return {
    controller: {
      name: "Brf Eksemplet",
      organizationNumber: null,
      contactEmail: null,
      postalAddress: null,
      officer: null,
      jointController: null,
    },
    activities: [activity],
  };
}

describe("a plugin's row that names no personal data", () => {
  it("says the plugin has not declared it", () => {
    render(<ProcessingActivitiesPanel record={record(PLUGIN_ROW)} />);

    expect(
      screen.getByText(/Personuppgifter: Inte angivet\. Tillägget kan läsa/),
    ).not.toBeNull();
  });

  it("lists the categories once the plugin declares them", () => {
    render(
      <ProcessingActivitiesPanel
        record={record({
          ...PLUGIN_ROW,
          personalDataCategories: ["name", "apartment"],
        })}
      />,
    );

    expect(screen.getByText("Personuppgifter: Namn, Lägenhet")).not.toBeNull();
    expect(screen.queryByText(/Inte angivet/)).toBeNull();
  });

  it("says nothing of the address book on an ended row", () => {
    // An ended row's plugin is gone, and what it could read no longer holds.
    render(
      <ProcessingActivitiesPanel
        record={record({ ...PLUGIN_ROW, endedAt: "2026-10-01T00:00:00.000Z" })}
      />,
    );

    expect(screen.queryByText(/Inte angivet/)).toBeNull();
  });
});
