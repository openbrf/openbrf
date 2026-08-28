import type { DynamicModule } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import { blame } from "./bootstrap";
import {
  type BootPlugin,
  emptyPluginBoot,
  type PluginBoot,
} from "./plugins/plugin-boot";

/**
 * Deciding which plugin, if any, a failed container build belongs to.
 *
 * A plugin whose providers do not resolve fails the whole application, and a
 * broken plugin must not be able to take the association's register offline
 * (ADR 0003) - so the bootstrap drops the plugin it can identify and builds
 * again. Everything here is about the word "identify".
 *
 * Dropping a plugin is not free. It disables a package the board consented to
 * and records it on the admin screen as broken, which a board has no way to
 * tell from a true report. So a guess is worse than an answer of "not a
 * plugin's": that one is rethrown, and an application that fails to start with
 * an accurate error is a problem an operator can act on.
 */

const PLUGINS_ROOT = "/data/plugins/node_modules";

function plugin(id: string, moduleName: string): BootPlugin {
  return {
    id,
    version: "1.0.0",
    manifest: {} as BootPlugin["manifest"],
    directory: `${PLUGINS_ROOT}/openbrf-plugin-${id}`,
    module: { module: { name: moduleName } } as unknown as DynamicModule,
    context: {} as BootPlugin["context"],
    host: {} as BootPlugin["host"],
    controllers: [],
    locales: {},
  };
}

function bootWith(...plugins: BootPlugin[]): PluginBoot {
  return { ...emptyPluginBoot(), plugins };
}

/** A failure raised inside a plugin's own bundle. */
function thrownIn(directory: string, message = "boom"): Error {
  const cause = new Error(message);
  cause.stack = [
    `Error: ${message}`,
    `    at Object.<anonymous> (${directory}/dist/server.cjs:3:9)`,
    "    at Module._compile (node:internal/modules/cjs/loader:1234:14)",
  ].join("\n");
  return cause;
}

describe("blame", () => {
  it("names the one plugin whose module the failure names", () => {
    const occupancy = plugin("occupancy", "OccupancyModule");
    const boot = bootWith(plugin("notices", "NoticesModule"), occupancy);

    const cause = new Error(
      "Nest can't resolve dependencies of the Summary (?). Please make sure " +
        "that the argument Absent at index [0] is available in the " +
        "OccupancyModule context.",
    );

    expect(blame(boot, cause)).toBe(occupancy);
  });

  /**
   * A provider whose constructor throws names no module at all, but it leaves
   * its own file in the stack. Without this arm the failure would be
   * unattributable and the boot would fail on a plugin's defect.
   */
  it("names the plugin the failure was thrown inside when nothing names a module", () => {
    const occupancy = plugin("occupancy", "OccupancyModule");
    const boot = bootWith(plugin("notices", "NoticesModule"), occupancy);

    expect(blame(boot, thrownIn(occupancy.directory))).toBe(occupancy);
  });

  /**
   * The decisive one. A fault in the application's own graph implicates no
   * plugin, and dropping one would disable a working package and tell the
   * board it was broken.
   */
  it("names nobody when the failure implicates no plugin", () => {
    const boot = bootWith(
      plugin("notices", "NoticesModule"),
      plugin("occupancy", "OccupancyModule"),
    );

    const cause = new Error(
      "Nest can't resolve dependencies of the AddressBookService (?).",
    );

    expect(blame(boot, cause)).toBeNull();
  });

  it("names nobody when the failure names two plugins and neither stack does", () => {
    const boot = bootWith(
      plugin("notices", "NoticesModule"),
      plugin("occupancy", "OccupancyModule"),
    );

    const cause = new Error(
      "A circular dependency between NoticesModule and OccupancyModule.",
    );

    expect(blame(boot, cause)).toBeNull();
  });

  /**
   * A bundler shortens a class name to a character or two. Matched as a
   * substring, one of those appears in almost any sentence - and it would read
   * as a confident, unique attribution to whichever plugin was minified.
   */
  it("does not read a short module name out of an unrelated word", () => {
    const boot = bootWith(plugin("occupancy", "t"));

    const cause = new Error("Nest cannot resolve the application's own graph.");

    expect(blame(boot, cause)).toBeNull();
  });

  it("still matches a short module name standing on its own", () => {
    const minified = plugin("occupancy", "t");
    const boot = bootWith(minified);

    expect(blame(boot, new Error("available in the t context."))).toBe(
      minified,
    );
  });

  /**
   * The two kinds of evidence are not worth the same. A frame inside a bundle
   * is this process's own record that the package's code ran and threw; the
   * message is text, composed by whatever threw it. A plugin that throws
   * `new Error("NoticesModule")` would otherwise have a working package the
   * board consented to disabled and recorded as broken, and would go on
   * running to fail the next attempt as well.
   */
  it("believes the stack over a message naming a different plugin", () => {
    const notices = plugin("notices", "NoticesModule");
    const occupancy = plugin("occupancy", "OccupancyModule");
    const boot = bootWith(notices, occupancy);

    const cause = thrownIn(occupancy.directory, "NoticesModule");

    expect(blame(boot, cause)).toBe(occupancy);
  });

  /**
   * One package's directory can be a prefix of another's, so a bare substring
   * would place a failure in whichever of the two was installed first - the
   * same wrong attribution by a different route.
   */
  it("does not read one package's directory out of another's", () => {
    const occupancy = plugin("occupancy", "OccupancyModule");
    const pro = plugin("occupancy-pro", "OccupancyProModule");
    const boot = bootWith(occupancy, pro);

    expect(blame(boot, thrownIn(pro.directory))).toBe(pro);
  });

  it("names nobody when no plugin contributed a module", () => {
    const viewOnly = {
      ...plugin("occupancy", "OccupancyModule"),
      module: null,
    };

    expect(blame(bootWith(viewOnly), new Error("OccupancyModule"))).toBeNull();
  });
});
