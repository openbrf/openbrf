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
 * and the board may clear them later; an empty list beside "Personal data"
 * would read as a processing of none, so the row says its record names none.
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
  it("says the record names none on a row the install left empty", () => {
    render(<ProcessingActivitiesPanel record={record(PLUGIN_ROW)} />);

    expect(
      screen.getByText(
        /Personuppgifter: Inga angivna\. Den här posten anger inga kategorier/,
      ),
    ).not.toBeNull();
  });

  it("claims nothing about permissions on a row the board has edited", () => {
    // The board cleared the categories of a plugin that may have no address
    // book permission and a manifest that did declare personal data.
    render(
      <ProcessingActivitiesPanel
        record={record({ ...PLUGIN_ROW, seeded: false, revision: 3 })}
      />,
    );

    const line = screen.getByText(/Personuppgifter: Inga angivna\./);
    expect(line.textContent).not.toMatch(/adressbok|deklarer|manifest/i);
    expect(screen.queryByText(/Inte angivet/)).toBeNull();
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
    expect(screen.queryByText(/Inga angivna/)).toBeNull();
  });

  it("says nothing on an ended row", () => {
    // An ended row's plugin is gone, and what it could read no longer holds.
    render(
      <ProcessingActivitiesPanel
        record={record({ ...PLUGIN_ROW, endedAt: "2026-10-01T00:00:00.000Z" })}
      />,
    );

    expect(screen.queryByText(/Inga angivna/)).toBeNull();
  });
});
