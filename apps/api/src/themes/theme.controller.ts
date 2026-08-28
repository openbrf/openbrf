import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { Public } from "../authorization/public.decorator";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  type CatalogThemeView,
  type ThemeInstallResult,
  ThemeInstallService,
} from "./theme-install.service";
import {
  type ThemeRendering,
  ThemeService,
  type ThemeSummary,
} from "./theme.service";

/**
 * The theme screens' endpoints.
 *
 * Split by who may reach them. What renders is public, because the sign-in
 * screen is themed and the answer is colours and typefaces. Everything that
 * changes the instance needs association:manage - a board seat alone does not
 * reconfigure the instance (plan section 4.3).
 */

const themeIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

const installSchema = z.object({ id: z.string().min(1).max(120) });

const activateSchema = z.object({
  /** Null, or the built-in theme's id, returns to the default theme. */
  id: themeIdSchema.nullable(),
});

const assetQuerySchema = z.object({
  theme: themeIdSchema,
  file: z.string().min(1).max(200),
});

/** Content types the asset route serves, keyed by extension. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  png: "image/png",
  webp: "image/webp",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
};

function requirePersonId(request: RequestWithPrincipal): string {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error("The authorization guard did not attach a principal.");
  }
  return principal.personId;
}

/**
 * What the instance renders, and the files a theme brought with it.
 *
 * Public because the sign-in screen has to be themed before anyone has a
 * session, and because everything here is styling: token values, font files
 * and a logo. Nothing about the register, the cooperative or any person passes
 * through these two routes.
 */
@Controller("api/themes")
export class ActiveThemeController {
  constructor(private readonly themes: ThemeService) {}

  @Get("active")
  @Public()
  async active(): Promise<ThemeRendering> {
    return this.themes.activeRendering();
  }

  @Get("asset")
  @Public()
  async asset(
    @Query() query: unknown,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { theme, file } = assetQuerySchema.parse(query);
    const asset = await this.themes.asset(theme, file);

    if (asset === null) {
      void reply.status(404).send({ statusCode: 404, error: "Not Found" });
      return;
    }

    const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
    void reply
      .header(
        "content-type",
        CONTENT_TYPES[extension] ?? "application/octet-stream",
      )
      // The browser must not guess a type: a mis-sniffed asset served from the
      // instance's own origin is how a file becomes a script.
      .header("x-content-type-options", "nosniff")
      // A theme's own files are inert data. Refusing every fetch a rendered
      // asset could make is belt and braces for anything the type allows.
      .header("content-security-policy", "default-src 'none'; sandbox")
      // Cached hard: an asset path belongs to one installed version, and a
      // reinstall of a different version writes different declarations.
      .header("cache-control", "public, max-age=3600")
      .send(asset.contents);
  }
}

/** Reading the instance's themes. Board-readable, per association:read. */
@Controller("api/themes")
@RequireCapability("association:read")
export class ThemeListController {
  constructor(private readonly themes: ThemeService) {}

  @Get("installed")
  async installed(): Promise<ThemeSummary[]> {
    return this.themes.list();
  }
}

/**
 * Installing, previewing, activating and removing. Admin only.
 *
 * The capability sits on the class so a route added here later inherits it
 * rather than being open by omission.
 */
@Controller("api/themes")
@RequireCapability("association:manage")
export class ThemeAdminController {
  constructor(
    private readonly themes: ThemeService,
    private readonly installer: ThemeInstallService,
  ) {}

  @Get("catalog")
  async catalog(): Promise<CatalogThemeView[]> {
    return this.installer.catalog();
  }

  @Post("install")
  async install(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<ThemeInstallResult> {
    const { id } = installSchema.parse(body);
    return this.installer.install(id, requirePersonId(request));
  }

  /**
   * Live preview.
   *
   * Nothing is written: the response is the same resolution activation would
   * produce, and the browser applies it to the session that asked. That is what
   * "preview" has to mean here - a board member trying a theme must not change
   * what every other resident is looking at.
   */
  @Get("installed/:id/preview")
  async preview(@Param("id") id: string): Promise<ThemeRendering> {
    return this.themes.renderingOf(themeIdSchema.parse(id));
  }

  @Post("activate")
  async activate(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<ThemeSummary[]> {
    const { id } = activateSchema.parse(body);
    return this.themes.activate(id, requirePersonId(request));
  }

  @Delete("installed/:id")
  async uninstall(@Param("id") id: string): Promise<ThemeSummary[]> {
    return this.themes.uninstall(themeIdSchema.parse(id));
  }
}
