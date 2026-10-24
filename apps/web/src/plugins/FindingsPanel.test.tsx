import {
  PLUGIN_FINDING_REASONS,
  type PluginFindingReason,
} from "@openbrf/plugin-sdk";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

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
    // Empty on purpose, like every other refusal a plugin's own code composed
    // the words for: what NestJS or the bundle said goes to the server log,
    // and only the code crosses the wire.
    "module-failed": {},
    "module-identity": { packages: ["@nestjs/common"] },
    "permissions-widened": { permissions: ["mail:send"] },
    "personal-data-widened": { categories: ["email", "residency"] },
    "not-consented": {},
    disabled: {},
    "load-failed": {},
    "actions-widened": { actions: ["occupancy_summary"] },
    "action-refused": { actions: ["occupancy_summary"] },
    "ai-changed": {},
    "licence-widened": {
      audiences: ["https://themes.example.org"],
      keys: ["example-2027-1"],
    },
    "licence-issuer-changed": { audiences: [], keys: ["other-2026-1"] },
    "block-refused": { blocks: ["poll"] },
    // Empty for the reason module-failed is: what the provider asked for goes
    // to the server log, and only the code crosses the wire.
    "forbidden-injection": {},
    "oauth-resource-conflict": {
      incumbent: "mcp-connector",
      path: "/api/plugin/mcp-connector/mcp",
    },
    "recipients-widened": { recipients: ["https://sync.example.test"] },
    "not-on-volume": {},
    "extension-host-missing": { plugin: "signage" },
    "extension-point-unknown": { plugin: "signage", point: "weather" },
    "extension-version-unsupported": {
      plugin: "signage",
      point: "source",
      version: 2,
      supported: 1,
    },
    "extension-personal-data-refused": {
      plugin: "signage",
      point: "source",
      categories: ["email"],
    },
    "extension-permission-refused": {
      plugin: "signage",
      point: "source",
      permissions: ["addressBook:read"],
    },
    "extension-host-personal-data-refused": {
      plugin: "signage",
      point: "display",
      categories: ["name"],
    },
    "extension-group-refused": {
      website: ["signage-website"],
      register: ["signage-residents"],
    },
    "extensions-widened": { extensions: ["signage/source"] },
    "extension-refused": { extensions: ["source"] },
    "device-routes-widened": { deviceRoutes: ["screen"] },
    "audit-rate-exceeded": { perMinute: 120 },
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

  it("names the collections when it is what a plugin keeps about a person that widened", () => {
    // ADR 0047: the same refusal, said about the collection.
    render(
      <FindingsPanel
        findings={[
          {
            ...findingFor("personal-data-widened"),
            detail: { collections: ["claims"] },
          },
        ]}
      />,
    );

    const text = sentence();
    expect(text).toContain("claims");
    expect(text).toContain("sparar mer om en person");
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

  it("reads a broken manifest rule in the board's language", () => {
    render(
      <FindingsPanel
        findings={[
          {
            ...findingFor("manifest-invalid"),
            detail: {
              issues: "openbrf.id: required",
              rules: ["device-route-reads-register"],
            },
          },
        ]}
      />,
    );

    // The code is read through the interface's own table, not shown, and the
    // schema's English line for the field's own problem stays beside it.
    const text = sentence();
    expect(text).toContain("får inte också läsa adressboken eller ekonomin");
    expect(text).toContain("openbrf.id: required");
    expect(text).not.toContain("device-route-reads-register");
  });

  it("reads the refused device-route extension point in the board's language", () => {
    render(
      <FindingsPanel
        findings={[
          {
            ...findingFor("manifest-invalid"),
            detail: {
              issues: "",
              rules: ["device-route-extension-point-contact"],
              specifics:
                "openbrf.extensionPoints.0.personalData: a plugin that declares deviceRoutes declares no extension point that accepts email",
            },
          },
        ]}
      />,
    );

    // The author's English line is for the boot log, not for this screen.
    const text = sentence();
    expect(text).toContain("utökningspunkt som tar emot e-postadresser");
    expect(text).not.toContain("device-route-extension-point-contact");
    expect(text).not.toContain("declares deviceRoutes");
  });

  it("sets two broken rules and a field problem side by side", () => {
    render(
      <FindingsPanel
        findings={[
          {
            ...findingFor("manifest-invalid"),
            detail: {
              issues: "openbrf.id: required",
              rules: ["device-route-reads-register", "blocks-read-register"],
            },
          },
        ]}
      />,
    );

    // Each rule sentence ends in a full stop; none is followed by a comma or
    // a semicolon.
    const text = sentence();
    expect(text).toContain("publiceras för alla.");
    expect(text).not.toMatch(/\.[,;]/);
    expect(text).toContain("openbrf.id: required");
  });

  it("reads a rule alone without a stray separator", () => {
    render(
      <FindingsPanel
        findings={[
          {
            ...findingFor("manifest-invalid"),
            detail: { issues: "", rules: ["blocks-read-register"] },
          },
        ]}
      />,
    );

    expect(sentence()).toMatch(/publiceras för alla\.$/);
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
