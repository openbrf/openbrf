import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { AuthService } from "../auth/auth.service";
import { createApplication, loadPluginsAtBoot } from "../bootstrap";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import { PrismaClient } from "../generated/prisma/client";
import { dataPaths } from "../packaging/data-paths";
import { PluginInstallerService } from "../plugins/plugin-installer.service";
import { PluginRegistryService } from "../plugins/plugin-registry.service";
import {
  loadEnvForIntegrationTests,
  restoreEnvironmentVariable,
  runSuffix,
} from "../testing/integration-env";

/**
 * A plugin's website blocks, from its package on the volume to a visitor's
 * browser, against a real database and through the real routing.
 *
 * The plugin is written by hand into a temporary data directory, as the boot
 * suites write theirs, and consented to with the `site:blocks` permission. It
 * declares five blocks and gives each a render function that is a way a block
 * can go wrong, or right:
 *
 *   notice    renders a heading in the reader's language, the board's message
 *             and a link off the instance - what an honest block looks like.
 *   injected  answers with a script, an event handler, a style and a
 *             `javascript:` link, the four things the host promises never
 *             reach the page.
 *   broken    throws.
 *   slow      never answers.
 *   leaky     renders something shaped like a personal identity number.
 *
 * One page holds all five between two paragraphs of the board's own. Every
 * assertion below is about that one stored page: what a visitor gets, what the
 * board's editor is offered, what a save is held to, and what is left once the
 * plugin is switched off and removed.
 */

const env = loadEnvForIntegrationTests();

const suffix = runSuffix();
const PLUGIN_ID = `site-blocks-${suffix}`;
const PACKAGE_NAME = `openbrf-plugin-${PLUGIN_ID}`;
const PASSWORD = "a-long-enough-password";
const admin = {
  personId: `plugin-blocks-admin-${suffix}`,
  email: `plugin-blocks-admin-${suffix}@exempel.se`,
};
const resident = {
  personId: `plugin-blocks-resident-${suffix}`,
  email: `plugin-blocks-resident-${suffix}@exempel.se`,
};
const PAGE_SLUG = `plugin-blocks-${suffix}`;
const MESSAGE = `Tvättstugan är stängd ${suffix}`;

const type = (name: string): string => `${PLUGIN_ID}/${name}`;

const BUNDLE = `const { Module } = require("@nestjs/common");

class SiteBlocksPluginModule {}
Module({})(SiteBlocksPluginModule);

exports.createPlugin = function createPlugin(host) {
  host.blocks.register({
    name: "notice",
    render: (context) => [
      { tag: "h2", children: [context.t("blocks.notice.heading")] },
      { tag: "p", children: [String(context.settings.message)] },
      {
        tag: "a",
        attributes: { href: "https://example.org/tvatt" },
        children: ["Mer om tvättstugan"],
      },
    ],
  });
  host.blocks.register({
    name: "injected",
    render: () => [
      {
        tag: "p",
        attributes: { onclick: "alert(1)", style: "color: red" },
        children: ["Injicerat stycke"],
      },
      { tag: "script", children: ["alert(document.cookie)"] },
      { tag: "img", attributes: { src: "https://tracker.invalid/pixel.gif" } },
      {
        tag: "a",
        attributes: { href: "javascript:alert(1)" },
        children: ["Klicka"],
      },
      "<script>alert(2)</script>",
    ],
  });
  host.blocks.register({
    name: "broken",
    render: () => {
      throw new Error("broken on purpose");
    },
  });
  host.blocks.register({
    name: "slow",
    render: () => new Promise(() => undefined),
  });
  host.blocks.register({
    name: "leaky",
    render: () => ({ tag: "p", children: ["Ordförande 19121212-1212"] }),
  });
  return { module: SiteBlocksPluginModule };
};
`;

const LOCALES = {
  sv: {
    blocks: {
      notice: {
        label: "Anslag",
        heading: "Anslag från tvättstugan",
        message: "Meddelande",
      },
      injected: { label: "Injicerat" },
      broken: { label: "Trasigt" },
      slow: { label: "Långsamt" },
      leaky: { label: "Läckande" },
    },
  },
  en: {
    blocks: {
      notice: {
        label: "Notice",
        heading: "Notice from the laundry",
        message: "Message",
      },
      injected: { label: "Injected" },
      broken: { label: "Broken" },
      slow: { label: "Slow" },
      leaky: { label: "Leaky" },
    },
  },
};

const DECLARED = ["notice", "injected", "broken", "slow", "leaky"] as const;

let app: NestFastifyApplication | undefined;
let prisma: PrismaService | undefined;
let workspace: string | undefined;
let previousDataDir: string | undefined;
let adminCookie = "";
let residentCookie = "";
let pageId = "";

function application(): NestFastifyApplication {
  if (app === undefined) {
    throw new Error("The application was not started.");
  }
  return app;
}

/**
 * A distinct forwarded address per request. 10.74.0.0/16 is this suite's; the
 * auth rate limiter buckets by forwarded address, and every integration suite
 * holds its own second octet.
 */
let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  return `10.74.${String(Math.floor(ipCounter / 254) % 254)}.${String((ipCounter % 254) + 1)}`;
}

function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: object;
  cookie?: string;
}) {
  return application()
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method,
      url: options.url,
      ...(options.payload === undefined ? {} : { payload: options.payload }),
      headers: {
        "x-forwarded-for": nextForwardedFor(),
        "accept-language": "sv-SE,sv;q=0.9",
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      },
    });
}

async function signIn(email: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: PASSWORD },
  });
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return cookies.map((value) => value.split(";")[0]).join("; ");
}

/** The page as a visitor with no account gets it. */
async function visit(): Promise<string> {
  const response = await inject({ method: "GET", url: `/${PAGE_SLUG}` });
  expect(response.statusCode).toBe(200);
  return response.body;
}

/** What the board's editor is told about the plugins' blocks. */
async function offered(): Promise<string[]> {
  const response = await inject({
    method: "GET",
    url: "/api/site/blocks",
    cookie: adminCookie,
  });
  expect(response.statusCode).toBe(200);
  return (response.json() as { blocks: { type: string }[] }).blocks.map(
    (block) => block.type,
  );
}

/** Saves the page with these blocks, as the board's editor sends a save. */
function save(blocks: unknown[]) {
  return inject({
    method: "PUT",
    url: `/api/site/pages/${pageId}`,
    cookie: adminCookie,
    payload: { slug: PAGE_SLUG, title: "Tvättstugan", content: { blocks } },
  });
}

const PAGE_BLOCKS = [
  { type: "paragraph", runs: [{ text: "Före tillägget." }] },
  { type: type("notice"), settings: { message: MESSAGE } },
  { type: type("injected"), settings: {} },
  { type: type("broken"), settings: {} },
  { type: type("slow"), settings: {} },
  { type: type("leaky"), settings: {} },
  { type: "paragraph", runs: [{ text: "Efter tillägget." }] },
];

beforeAll(async () => {
  const created = await mkdtemp(join(tmpdir(), "openbrf-plugin-blocks-"));
  workspace = created;
  const directory = join(
    dataPaths(created).plugins,
    "node_modules",
    PACKAGE_NAME,
  );
  await mkdir(join(directory, "dist"), { recursive: true });
  await mkdir(join(directory, "locales"), { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: PACKAGE_NAME,
      version: "1.0.0",
      openbrf: {
        apiVersion: 1,
        id: PLUGIN_ID,
        entry: { server: "./dist/server.cjs" },
        permissions: ["site:blocks"],
        personalData: [],
        blocks: DECLARED.map((name) => ({
          name,
          labelKey: `blocks.${name}.label`,
          icon: "plugin",
          category: "association",
          ...(name === "notice"
            ? {
                settingsSchema: {
                  fields: [
                    {
                      key: "message",
                      labelKey: "blocks.notice.message",
                      type: "text",
                      required: true,
                      maxLength: 200,
                    },
                  ],
                },
              }
            : {}),
        })),
      },
    }),
    "utf8",
  );
  await writeFile(join(directory, "dist", "server.cjs"), BUNDLE, "utf8");
  for (const [locale, strings] of Object.entries(LOCALES)) {
    await writeFile(
      join(directory, "locales", `${locale}.json`),
      JSON.stringify(strings),
      "utf8",
    );
  }

  const consenting = new PrismaClient({
    adapter: new PrismaPg({ connectionString: env.DATABASE_URL }),
  });
  try {
    await new PluginRegistryService(
      consenting as unknown as ConstructorParameters<
        typeof PluginRegistryService
      >[0],
    ).consent({
      id: PLUGIN_ID,
      packageName: PACKAGE_NAME,
      version: "1.0.0",
      tarballUrl: `file:///dev/null/${PLUGIN_ID}.tgz`,
      checksum: "sha512-unused-in-this-suite",
      permissions: ["site:blocks"],
      personalData: [],
      actions: [],
      deviceRoutes: [],
      ai: false,
      licence: null,
    });
  } finally {
    await consenting.$disconnect();
  }

  // Set on the environment as well as passed in: the application's own
  // configuration module reads process.env when the container is built.
  previousDataDir = process.env.OPENBRF_DATA_DIR;
  process.env.OPENBRF_DATA_DIR = created;
  const started = await createApplication(
    await loadPluginsAtBoot({
      ...env,
      OPENBRF_DATA_DIR: created,
      OPENBRF_PLUGINS_ENABLED: true,
    } satisfies Env),
  );
  app = started;
  await started.init();
  await started.getHttpAdapter().getInstance().ready();

  /*
   * Removing a plugin ends by asking the installer to take the package off the
   * volume and restart the process. Neither belongs in a suite: what removal
   * does to the running website happens before that request, and is what is
   * asserted here.
   */
  vi.spyOn(started.get(PluginInstallerService), "enqueue").mockResolvedValue(
    undefined as never,
  );

  const database = started.get(PrismaService);
  prisma = database;
  await database.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Brf Eksemplet",
      organizationNumber: "769600-0000",
      setupCompletedAt: new Date(),
    },
    update: { setupCompletedAt: new Date() },
  });
  const stored = await database.page.create({
    data: {
      slug: PAGE_SLUG,
      title: "Tvättstugan",
      content: { version: 1, blocks: PAGE_BLOCKS },
      status: "PUBLIC",
      publishedAt: new Date(),
      sortOrder: 950,
    },
  });
  pageId = stored.id;

  await database.person.create({
    data: {
      id: admin.personId,
      firstName: "Test",
      lastName: `Block${suffix}`,
      preferredLocale: "sv",
    },
  });
  await started.get(AuthService).createAccountForPerson({
    personId: admin.personId,
    email: admin.email,
    name: "Test Person",
    password: PASSWORD,
  });
  await database.systemRole.create({
    data: { personId: admin.personId, role: "ADMIN" },
  });
  adminCookie = await signIn(admin.email);

  // An account with no system role and no grant: it can sign in, and holds no
  // `site:manage`.
  await database.person.create({
    data: {
      id: resident.personId,
      firstName: "Test",
      lastName: `Resident${suffix}`,
      preferredLocale: "sv",
    },
  });
  await started.get(AuthService).createAccountForPerson({
    personId: resident.personId,
    email: resident.email,
    name: "Test Resident",
    password: PASSWORD,
  });
  residentCookie = await signIn(resident.email);
}, 180_000);

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      const client = prisma;
      await client.page.deleteMany({ where: { slug: PAGE_SLUG } });
      await client.installedPlugin.deleteMany({ where: { id: PLUGIN_ID } });
      const personIds = [admin.personId, resident.personId];
      await client.systemRole.deleteMany({
        where: { personId: { in: personIds } },
      });
      await client.session.deleteMany({
        where: { user: { personId: { in: personIds } } },
      });
      await client.account.deleteMany({
        where: { user: { personId: { in: personIds } } },
      });
      await client.user.deleteMany({
        where: { personId: { in: personIds } },
      });
      await client.person.deleteMany({ where: { id: { in: personIds } } });
    }
    if (app !== undefined) {
      await app.close();
    }
  } finally {
    restoreEnvironmentVariable("OPENBRF_DATA_DIR", previousDataDir);
    if (workspace !== undefined) {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

describe("a serving plugin's blocks", () => {
  it("are registered and offered to the board's editor", async () => {
    expect(await offered()).toEqual(DECLARED.map((name) => type(name)));

    const response = await inject({
      method: "GET",
      url: "/api/site/blocks",
      cookie: adminCookie,
    });
    const notice = (
      response.json() as {
        blocks: { type: string; labelKey: string; fields: unknown[] }[];
      }
    ).blocks.find((block) => block.type === type("notice"));
    expect(notice).toMatchObject({
      pluginId: PLUGIN_ID,
      labelKey: "blocks.notice.label",
      icon: "plugin",
      category: "association",
      fields: [{ key: "message", type: "text", required: true }],
    });
  });

  it("are not offered to somebody who is not signed in", async () => {
    const response = await inject({ method: "GET", url: "/api/site/blocks" });

    expect(response.statusCode).toBe(401);
  });

  it("are not offered to somebody signed in who may not manage the website", async () => {
    expect(residentCookie).not.toBe("");

    const response = await inject({
      method: "GET",
      url: "/api/site/blocks",
      cookie: residentCookie,
    });

    expect(response.statusCode).toBe(403);
  });

  it("render on the page, in the reader's language", async () => {
    const html = await visit();

    expect(html).toContain(
      `<div class="site-plugin-block"><h2>Anslag från tvättstugan</h2><p>${MESSAGE}</p><a href="https://example.org/tvatt" rel="noopener noreferrer">Mer om tvättstugan</a></div>`,
    );
  });

  it("have a script, a handler, a style and a foreign picture stripped", async () => {
    const html = await visit();

    expect(html).toContain("<p>Injicerat stycke</p>");
    expect(html).toContain("<a>Klicka</a>");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(document.cookie)");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("tracker.invalid");
    expect(html).not.toContain("<img");
    expect(/\son[a-z]+=/i.test(html)).toBe(false);
    expect(html).not.toContain('style="');
  });

  it("hide only themselves when they throw, hang or leak", async () => {
    const started = Date.now();
    const html = await visit();

    // The page waited for the slow block once, and no longer.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(html).toContain("<p>Före tillägget.</p>");
    expect(html).toContain("<p>Efter tillägget.</p>");
    expect(html).not.toContain("broken on purpose");
    expect(html).not.toContain("19121212");
    // Two blocks rendered: the notice and the injected one, and no other.
    expect(html.match(/class="site-plugin-block"/g)).toHaveLength(2);
  });

  it("hold a save to the block's declared settings", async () => {
    const refused = await save([
      { type: type("notice"), settings: { message: "" } },
    ]);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ reason: "invalid-body" });

    const accepted = await save(PAGE_BLOCKS);
    expect(accepted.statusCode).toBe(200);
  });
});

describe("a plugin's blocks once the plugin is switched off and removed", () => {
  it("are no longer offered, and render nothing", async () => {
    const disabled = await inject({
      method: "PUT",
      url: `/api/plugins/${PLUGIN_ID}/enabled`,
      cookie: adminCookie,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);

    expect(await offered()).toEqual([]);
    const html = await visit();
    expect(html).not.toContain(`class="site-plugin-block"`);
    expect(html).not.toContain(MESSAGE);
    expect(html).toContain("<p>Före tillägget.</p><p>Efter tillägget.</p>");
  });

  it("stay stored on the page after the plugin is removed", async () => {
    const removed = await inject({
      method: "DELETE",
      url: `/api/plugins/${PLUGIN_ID}`,
      cookie: adminCookie,
    });
    expect(removed.statusCode).toBe(200);

    const page = await inject({
      method: "GET",
      url: `/api/site/pages/${pageId}`,
      cookie: adminCookie,
    });
    const blocks = (page.json() as { content: { blocks: { type: string }[] } })
      .content.blocks;
    expect(blocks.map((block) => block.type)).toEqual(
      PAGE_BLOCKS.map((block) => block.type),
    );

    // A save carries the blocks back untouched, settings the plugin would
    // now refuse included: nobody here can read them any more.
    const saved = await save([
      ...PAGE_BLOCKS,
      { type: type("notice"), settings: { message: "" } },
    ]);
    expect(saved.statusCode).toBe(200);

    const html = await visit();
    expect(html).not.toContain(`class="site-plugin-block"`);
    expect(html).toContain("<p>Före tillägget.</p><p>Efter tillägget.</p>");
  });
});
