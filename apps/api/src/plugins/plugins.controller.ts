import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import {
  PLUGIN_PERMISSIONS,
  PLUGIN_PERSONAL_DATA_CATEGORIES,
  pluginActionsSchema,
  pluginIdSchema,
} from "@openbrf/plugin-sdk";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  type CatalogPluginView,
  PluginAdminService,
  type PluginSettingsView,
  type PluginsOverview,
  type PluginViewDescriptor,
} from "./plugin-admin.service";

const installSchema = z.object({
  id: pluginIdSchema,
  /** Echoed from the consent screen so a changed entry is refused. */
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(16),
  personalData: z.array(z.enum(PLUGIN_PERSONAL_DATA_CATEGORIES)).max(16),
  /**
   * The third of the three, and it has to be named here to survive.
   *
   * `z.object` strips what it does not declare, so an omission is not a field
   * that arrives unchecked - it is a field that never arrives at all. The
   * service compares the echo as one unit, so actions reaching it as undefined
   * reads as a board that consented to no action, and every install of a plugin
   * that declares one is refused with a mismatch nothing on the screen can
   * satisfy. Required rather than defaulted, for the same reason the two above
   * are: a default would put the empty list back and the refusal with it.
   */
  actions: pluginActionsSchema,
  /**
   * What the board answered about where this plugin sends personal data.
   *
   * Optional, because a board may install now and classify the recipient on the
   * data protection screen afterwards. Until it does, the recipient reads as
   * not recorded - a question the screen asks rather than a gap it hides.
   */
  processorAgreement: z
    .object({
      sendsPersonalDataOutside: z.boolean(),
      recipient: z.string().trim().max(200).optional(),
      classification: z
        .enum(["PROCESSOR", "INDEPENDENT_CONTROLLER"])
        .optional(),
      status: z.enum(["IN_PLACE", "PENDING"]).optional(),
      counterparty: z.string().trim().max(200).optional(),
      reference: z.string().trim().max(200).optional(),
      signedOn: z.iso.date().optional(),
      termsConfirmed: z.boolean().optional(),
      subProcessorsAuthorised: z.boolean().optional(),
      subProcessorNote: z.string().trim().max(1000).optional(),
      note: z.string().trim().max(1000).optional(),
    })
    .optional(),
});

const enabledSchema = z.object({ enabled: z.boolean() });
const settingsSchema = z.object({ values: z.record(z.string(), z.unknown()) });
const idSchema = z.object({ id: pluginIdSchema });
const actionParamsSchema = z.object({
  id: pluginIdSchema,
  actionId: z.string().regex(/^[a-z][a-z0-9_]{2,31}$/),
});
const armedSchema = z.object({ armed: z.boolean() });

/**
 * The acting person, or a fault.
 *
 * The global guard attaches a principal to every non-public route or rejects
 * it, so reaching this throw means the guard stopped doing that, and a 500
 * naming the guard is the honest answer.
 */
function requirePersonId(request: RequestWithPrincipal): string {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error("The authorization guard did not attach a principal.");
  }
  return principal.personId;
}

/**
 * Reading which plugins this instance runs.
 *
 * association:read rather than association:manage: the board answers for what
 * runs on the instance and for the personal data those plugins reach, so it
 * has to be able to see the list, while installing and removing stays with an
 * admin (plan section 4.3).
 */
@Controller("api/plugins")
@RequireCapability("association:read")
export class PluginsReadController {
  constructor(private readonly plugins: PluginAdminService) {}

  @Get()
  async overview(): Promise<PluginsOverview> {
    return this.plugins.overview();
  }
}

/**
 * The plugin views a signed-in person may load.
 *
 * Its own controller at self:manage because a plugin view can be for
 * residents, and reading which views exist must not require the ability to
 * read the instance's configuration.
 */
@Controller("api/plugin-views")
@RequireCapability("self:manage")
export class PluginViewsController {
  constructor(private readonly plugins: PluginAdminService) {}

  @Get()
  views(): { views: PluginViewDescriptor[] } {
    return { views: this.plugins.views() };
  }
}

/**
 * Installing, removing and configuring. Admin only.
 *
 * The capability sits on the class so a route added here later inherits it
 * rather than being open by omission.
 */
@Controller("api/plugins")
@RequireCapability("association:manage")
export class PluginsWriteController {
  constructor(private readonly plugins: PluginAdminService) {}

  @Get("catalog")
  async catalog(): Promise<{
    source: string;
    entries: CatalogPluginView[];
  }> {
    return this.plugins.browseCatalog();
  }

  /**
   * Installs from the catalog.
   *
   * Answers before the plugin is on the volume: the install runs as a
   * background job and ends by replacing the process, so the response says
   * that a restart is coming rather than waiting for a request the restart
   * would cut off anyway.
   */
  @Post()
  async install(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<{ restarting: boolean }> {
    return this.plugins.install(
      installSchema.parse(body),
      requirePersonId(request),
      "WEB",
    );
  }

  @Delete(":id")
  async uninstall(
    @Req() request: RequestWithPrincipal,
    @Param() params: unknown,
  ): Promise<{ restarting: boolean }> {
    return this.plugins.uninstall(
      idSchema.parse(params).id,
      requirePersonId(request),
      "WEB",
    );
  }

  @Put(":id/enabled")
  async setEnabled(
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<{ restarting: boolean }> {
    return this.plugins.setEnabled(
      idSchema.parse(params).id,
      enabledSchema.parse(body).enabled,
    );
  }

  /**
   * Arms or disarms one of a plugin's declared actions.
   *
   * On this controller rather than beside the connected-apps screens, and so
   * at association:manage: arming is the same authority that installed the
   * plugin and consented to what it may do, exercised on the same screen. The
   * board's reach over what a connected app has already been given is a
   * different question, answered by the connected-apps screen.
   */
  @Put(":id/actions/:actionId")
  async setActionArmed(
    @Param() params: unknown,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<void> {
    const { id, actionId } = actionParamsSchema.parse(params);
    await this.plugins.setActionArmed(
      id,
      actionId,
      armedSchema.parse(body).armed,
      requirePersonId(request),
    );
  }

  @Get(":id/settings")
  async readSettings(@Param() params: unknown): Promise<PluginSettingsView> {
    return this.plugins.readSettings(idSchema.parse(params).id);
  }

  @Put(":id/settings")
  async writeSettings(
    @Param() params: unknown,
    @Body() body: unknown,
  ): Promise<PluginSettingsView> {
    return this.plugins.writeSettings(
      idSchema.parse(params).id,
      settingsSchema.parse(body).values,
    );
  }

  /**
   * Re-runs the reconcile.
   *
   * The recovery action for a failed install and for a deployment whose
   * /data/plugins is not a persistent volume, where every boot starts with an
   * empty installation directory.
   */
  @Post("reconcile")
  async reconcile(): Promise<{ queued: true }> {
    await this.plugins.reconcile(true);
    return { queued: true };
  }
}
