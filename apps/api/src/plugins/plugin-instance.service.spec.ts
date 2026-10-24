import { describe, expect, it, vi } from "vite-plus/test";

import type { Env } from "../config/env";
import type { PrismaService } from "../database/prisma.service";
import { PluginInstanceService } from "./plugin-instance.service";

/**
 * What `host.instance` tells a plugin: the association's name and the public
 * origin, and nothing else of the association's settings.
 */

function serviceReading(
  row: { name: string } | null,
  appUrl = "https://brf.example.se",
) {
  const findUnique = vi.fn(async (_query: unknown) => row);
  const prisma = { association: { findUnique } } as unknown as PrismaService;
  const env = { APP_URL: appUrl } as Env;
  return { service: new PluginInstanceService(prisma, env), findUnique };
}

describe("read", () => {
  it("reads the name and nothing else", async () => {
    const { service, findUnique } = serviceReading({ name: "Brf Talgoxen" });

    await expect(service.read()).resolves.toEqual({
      name: "Brf Talgoxen",
      origin: "https://brf.example.se",
    });

    const query = findUnique.mock.calls[0]?.[0] as {
      where: unknown;
      select: Record<string, unknown>;
    };
    // The select is the boundary: no organisation number, no contact details.
    expect(query.select).toEqual({ name: true });
    expect(query.where).toEqual({ id: 1 });
  });

  it("answers with no name on an instance not set up yet", async () => {
    const { service } = serviceReading(null);

    await expect(service.read()).resolves.toEqual({
      name: null,
      origin: "https://brf.example.se",
    });
  });

  it("drops the spaces around the name, and a name that is only spaces", async () => {
    await expect(
      serviceReading({ name: "  Brf Talgoxen " }).service.read(),
    ).resolves.toMatchObject({ name: "Brf Talgoxen" });
    await expect(
      serviceReading({ name: " \t " }).service.read(),
    ).resolves.toMatchObject({ name: null });
  });

  it.each([
    ["https://brf.example.se/", "https://brf.example.se"],
    ["https://BRF.Example.se", "https://brf.example.se"],
    ["https://brf.example.se:443", "https://brf.example.se"],
    ["https://brf.example.se:8443", "https://brf.example.se:8443"],
    ["http://localhost:5173", "http://localhost:5173"],
  ])("writes APP_URL %s as the origin %s", async (appUrl, origin) => {
    const { service } = serviceReading({ name: "Brf Talgoxen" }, appUrl);

    await expect(service.read()).resolves.toMatchObject({ origin });
  });

  it("reads the name on every call, so a renamed association is seen", async () => {
    const { service, findUnique } = serviceReading({ name: "Brf Talgoxen" });
    findUnique.mockResolvedValueOnce({ name: "Brf Talgoxen" });
    findUnique.mockResolvedValueOnce({ name: "Brf Blåmesen" });

    await expect(service.read()).resolves.toMatchObject({
      name: "Brf Talgoxen",
    });
    await expect(service.read()).resolves.toMatchObject({
      name: "Brf Blåmesen",
    });
  });
});
