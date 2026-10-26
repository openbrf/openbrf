import {
  ImportProposalRefusedError,
  type PluginManifest,
  PluginHostUnavailableError,
  PluginPermissionError,
} from "@openbrf/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ImportError } from "../import/import-errors";
import {
  createPluginHost,
  PluginHostBinding,
  type PluginHostContext,
  type PluginHostServices,
  routeCapabilityFloor,
} from "./plugin-host";

/**
 * The contract of `host.imports` (ADR 0043): a plugin hands the core a member
 * list and is told the receipt, a refusal's reason and where its own proposals
 * stand. It cannot read the register and it cannot apply anything, whatever it
 * proposes.
 */

const MANIFEST: PluginManifest = {
  apiVersion: 1,
  personRecords: [],
  id: "mailed-list",
  entry: { server: "./dist/server.cjs" },
  permissions: ["addressBook:proposeImport"],
  personalData: [
    "name",
    "apartment",
    "residency",
    "email",
    "phone",
    "personalIdentityNumber",
    "protected",
  ],
  recipients: [],
  actions: [],
  deviceRoutes: [],
  residentRoutes: [],
  extensionPoints: [],
  extends: [],
  ai: false,
  blocks: [],
};

function proposalService() {
  return {
    propose: vi.fn(async () => ({
      proposalId: "proposal-1",
      rowCount: 2,
      expiresAt: "2026-11-05T12:00:00.000Z",
    })),
    status: vi.fn(async () => ({ state: "pending", decidedAt: null })),
    withdraw: vi.fn(async () => true),
  };
}

describe("host.imports", () => {
  let binding: PluginHostBinding;
  let context: PluginHostContext;
  let proposals: ReturnType<typeof proposalService>;
  let residents: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    binding = new PluginHostBinding();
    proposals = proposalService();
    residents = vi.fn(async () => []);
    binding.bind({
      importProposals: proposals,
      addressBook: { residents, apartments: residents, summary: residents },
      finances: { charges: vi.fn(), notifications: vi.fn() },
    } as unknown as PluginHostServices);
    context = {
      manifest: MANIFEST,
      consented: ["addressBook:proposeImport"],
      serving: true,
      bufferedActions: [],
      bufferedBlocks: [],
      bufferedExtensionPoints: [],
      bufferedContributions: [],
    };
  });

  it("proposes as the plugin it is, with the bytes it was handed", async () => {
    const host = createPluginHost(binding, context);
    const file = new TextEncoder().encode("xxAdress;Namn\nA;B\n");

    const receipt = await host.imports.propose({
      fileName: "medlemmar.csv",
      // A view into a larger buffer: the core reads these bytes and no others.
      content: file.subarray(2),
      sender: "styrelsen@exempel.se",
    });

    expect(receipt).toEqual({
      proposalId: "proposal-1",
      rowCount: 2,
      expiresAt: "2026-11-05T12:00:00.000Z",
    });
    expect(proposals.propose).toHaveBeenCalledTimes(1);
    const [pluginId, passed] = proposals.propose.mock.calls[0] as unknown as [
      string,
      { fileName: string; content: Buffer; sender: string | null },
    ];
    expect(pluginId).toBe("mailed-list");
    expect(passed.fileName).toBe("medlemmar.csv");
    expect(passed.content.toString("utf8")).toBe("Adress;Namn\nA;B\n");
    expect(passed.sender).toBe("styrelsen@exempel.se");
  });

  it("passes no sender for a source that has none", async () => {
    const host = createPluginHost(binding, context);

    await host.imports.propose({
      fileName: "export.csv",
      content: new Uint8Array([65]),
    });

    expect(proposals.propose).toHaveBeenCalledWith(
      "mailed-list",
      expect.objectContaining({ sender: null }),
    );
  });

  it("treats a null sender as none", async () => {
    const host = createPluginHost(binding, context);

    await host.imports.propose({
      fileName: "export.csv",
      content: new Uint8Array([65]),
      sender: null,
    } as never);

    expect(proposals.propose).toHaveBeenCalledWith(
      "mailed-list",
      expect.objectContaining({ sender: null }),
    );
  });

  it("refuses with the reason alone, and nothing from the core's message", async () => {
    proposals.propose.mockRejectedValueOnce(
      new ImportError(
        "That file has more than 5000 rows below its column titles.",
        "too-many-rows",
      ),
    );
    const host = createPluginHost(binding, context);

    const refused: unknown = await host.imports
      .propose({ fileName: "a.csv", content: new Uint8Array([65]) })
      .catch((cause: unknown) => cause);

    expect(refused).toBeInstanceOf(ImportProposalRefusedError);
    expect((refused as ImportProposalRefusedError).reason).toBe(
      "too-many-rows",
    );
    expect((refused as Error).message).not.toContain("5000");
  });

  it("passes a fault through as it is", async () => {
    const fault = new Error("connection reset");
    proposals.propose.mockRejectedValueOnce(fault);
    const host = createPluginHost(binding, context);

    await expect(
      host.imports.propose({
        fileName: "a.csv",
        content: new Uint8Array([65]),
      }),
    ).rejects.toBe(fault);
  });

  it.each([
    [
      "a file name that is no string",
      { fileName: 1, content: new Uint8Array() },
      "file-name-invalid",
    ],
    [
      "a sender that is no string",
      { fileName: "a.csv", content: new Uint8Array([65]), sender: 5 },
      "sender-invalid",
    ],
    [
      "content that is no bytes",
      { fileName: "a.csv", content: "a;b" },
      "file-unreadable",
    ],
  ])("refuses %s before the core is asked", async (_what, file, reason) => {
    const host = createPluginHost(binding, context);

    const refused: unknown = await host.imports
      .propose(file as never)
      .catch((cause: unknown) => cause);

    expect((refused as ImportProposalRefusedError).reason).toBe(reason);
    expect(proposals.propose).not.toHaveBeenCalled();
  });

  it("reads and withdraws only under its own id", async () => {
    const host = createPluginHost(binding, context);

    await host.imports.status("proposal-1");
    await host.imports.withdraw("proposal-1");

    expect(proposals.status).toHaveBeenCalledWith("mailed-list", "proposal-1");
    expect(proposals.withdraw).toHaveBeenCalledWith(
      "mailed-list",
      "proposal-1",
    );
  });

  it("refuses a plugin that did not declare addressBook:proposeImport", async () => {
    const host = createPluginHost(binding, {
      ...context,
      manifest: { ...MANIFEST, permissions: ["addressBook:read"] },
      consented: ["addressBook:read"],
    });

    await expect(
      host.imports.propose({
        fileName: "a.csv",
        content: new Uint8Array([65]),
      }),
    ).rejects.toBeInstanceOf(PluginPermissionError);
    await expect(host.imports.status("proposal-1")).rejects.toBeInstanceOf(
      PluginPermissionError,
    );
    await expect(host.imports.withdraw("proposal-1")).rejects.toBeInstanceOf(
      PluginPermissionError,
    );
    expect(proposals.propose).not.toHaveBeenCalled();
  });

  it("refuses a plugin the board switched off", async () => {
    const host = createPluginHost(binding, { ...context, serving: false });

    await expect(
      host.imports.propose({
        fileName: "a.csv",
        content: new Uint8Array([65]),
      }),
    ).rejects.toBeInstanceOf(PluginHostUnavailableError);
  });

  describe("what the permission does not grant", () => {
    it("reads nothing from the register or the finances", async () => {
      const host = createPluginHost(binding, context);

      await expect(host.addressBook.residents()).rejects.toBeInstanceOf(
        PluginPermissionError,
      );
      await expect(host.addressBook.apartments()).rejects.toBeInstanceOf(
        PluginPermissionError,
      );
      await expect(host.addressBook.summary()).rejects.toBeInstanceOf(
        PluginPermissionError,
      );
      await expect(
        host.finances.charges({ from: "2026-01-01", to: "2026-12-31" }),
      ).rejects.toBeInstanceOf(PluginPermissionError);
      expect(residents).not.toHaveBeenCalled();
    });

    it("offers no way to apply, open or decide a proposal", () => {
      const host = createPluginHost(binding, context);

      // Proposing, reading its own state and taking it back. Opening, the
      // preview, the decisions and the apply are the board's, on the core's
      // own import screen.
      expect(Object.keys(host.imports).sort()).toEqual([
        "propose",
        "status",
        "withdraw",
      ]);
    });

    it("raises no route's capability floor", () => {
      // A plugin that holds nothing from the register has nothing to expose
      // through its routes.
      expect(routeCapabilityFloor(["addressBook:proposeImport"])).toEqual([
        "self:manage",
      ]);
    });
  });
});
