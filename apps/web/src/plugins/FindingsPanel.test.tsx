import {
  PLUGIN_FINDING_REASONS,
  type PluginFindingReason,
} from "@openbrf/plugin-sdk";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import "../i18n";
import { FindingsPanel } from "./FindingsPanel";
import type { PluginFinding } from "./plugin-api";

/**
 * The panel that says why a plugin is not running.
 *
 * The interface is Swedish and the API is English throughout, so the whole
 * point of the split under test is that the server sends a code and this
 * screen chooses the sentence. A board member reading an English sentence here
 * is reading one the server composed, which is the failure these assertions
 * are for.
 */

/** The values each reason's sentence needs, as the API sends them. */
const DETAILS: Readonly<Record<PluginFindingReason, PluginFinding["detail"]>> =
  {
    "manifest-invalid": { issues: "openbrf.id: required" },
    "api-version-unsupported": { apiVersion: 9 },
    "entry-missing": { entry: "dist/server.cjs" },
    "entry-invalid": {},
    "module-invalid": {},
    "module-refused": {},
    "module-failed": {
      error: "Error: Nest could not resolve OccupancyService",
    },
    "module-identity": { packages: ["@nestjs/common"] },
    "permissions-widened": { permissions: ["mail:send"] },
    "personal-data-widened": { categories: ["email", "residency"] },
    "not-consented": {},
    disabled: {},
    "load-failed": { error: "Error: this plugin is broken" },
    "not-on-volume": {},
  };

function findingFor(reason: string): PluginFinding {
  return {
    id: "occupancy",
    directory: "/data/plugins/node_modules/openbrf-plugin-occupancy",
    reason,
    detail: DETAILS[reason as PluginFindingReason] ?? {},
  };
}

/** The finding's sentence, which is the second line of its entry. */
function sentence(): string {
  const item = screen.getByRole("listitem");
  return item.textContent ?? "";
}

describe("FindingsPanel", () => {
  it.each([...PLUGIN_FINDING_REASONS])(
    "reads %s as a sentence of its own",
    (reason) => {
      render(<FindingsPanel findings={[findingFor(reason)]} />);

      const text = sentence();
      // Nothing left to interpolate: a placeholder on screen means the API
      // sent a detail under a name the sentence does not use, or the other
      // way round.
      expect(text).not.toContain("{{");
      // Not the key itself, which is what i18next renders for a key that is
      // not in the resources.
      expect(text).not.toContain("plugins.findings.reasons");
      expect(text).not.toContain(reason);
    },
  );

  it("gives each reason a sentence that is not another reason's", () => {
    const sentences = PLUGIN_FINDING_REASONS.map((reason) => {
      const view = render(<FindingsPanel findings={[findingFor(reason)]} />);
      const text = sentence();
      view.unmount();
      return text;
    });

    expect(new Set(sentences).size).toBe(PLUGIN_FINDING_REASONS.length);
  });

  it("reads a widened personal-data declaration in the board's language", () => {
    render(<FindingsPanel findings={[findingFor("personal-data-widened")]} />);

    // The categories arrive as the contract's codes and are read through the
    // same table the consent screen used, because `residency` on its own tells
    // a board nothing about what it is being asked to agree to.
    const text = sentence();
    expect(text).toContain("E-postadress");
    expect(text).toContain("om personen är medlem");
    expect(text).not.toContain("residency");
  });

  it("names a permission a republished package asks for", () => {
    render(<FindingsPanel findings={[findingFor("permissions-widened")]} />);

    expect(sentence()).toContain("Skicka e-post via föreningens egen server");
  });

  it("still answers in words when the code is one it has never heard of", () => {
    render(<FindingsPanel findings={[findingFor("a-reason-from-later")]} />);

    // The code is named here, unlike in the sentences above: it is the only
    // thing this version can say about it, and it is what an operator would
    // look up.
    expect(sentence()).toContain("a-reason-from-later");
  });

  it("renders nothing at all when every plugin is running", () => {
    const { container } = render(<FindingsPanel findings={[]} />);

    expect(container.innerHTML).toBe("");
  });
});
