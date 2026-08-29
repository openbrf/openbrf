import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { SUPPORTED_LOCALES } from "../i18n/i18n.service";
import { isTooLarge, readSingleFile } from "../http/multipart";
import { MediaError } from "../media/media.service";
import {
  type BrandingSettings,
  type HousingCooperativeSettings,
  type InstanceSettings,
  type LogoSlot,
  SettingsService,
  type SmtpSettingsView,
} from "./settings.service";

const housingCooperativeSchema = z.object({
  name: z.string().min(1).max(200),
  // Swedish organisation numbers are ten digits, usually written with a hyphen
  // before the last four. Both forms are accepted and stored as typed: this is
  // an identifier printed on statutory documents, not a value to normalise
  // behind the board's back.
  organizationNumber: z
    .string()
    .regex(/^\d{6}-?\d{4}$/, "must be ten digits, optionally hyphenated")
    .nullish(),
  defaultLocale: z.enum(SUPPORTED_LOCALES),
});

const brandingSchema = z.object({
  /** Null clears the override and returns to the default theme's accent. */
  primaryColor: z.string().min(1).max(64).nullable(),
});

const smtpSchema = z.object({
  host: z.string().min(1).max(255).nullable(),
  port: z.coerce.number().int().min(1).max(65535).nullable(),
  secure: z.boolean(),
  user: z.string().max(255).nullable(),
  /** Omit to keep the stored password; null or "" to clear it. */
  password: z.string().max(200).nullish(),
  fromAddress: z.email().max(320).nullable(),
});

/**
 * Bounds on the retention policy.
 *
 * A floor exists because a policy of zero days would make service data vanish
 * the moment someone moves out, before the board has finished handling the
 * move. The ceiling is ten years, past which "retention policy" stops meaning
 * anything. Neither bound touches the statutory archive: the member register
 * and the audit log are append-only in the database and are exempt from
 * purging entirely.
 */
const MIN_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;

const retentionSchema = z.object({
  daysAfterMoveOut: z.coerce
    .number()
    .int()
    .min(MIN_RETENTION_DAYS)
    .max(MAX_RETENTION_DAYS),
});

const selfSignupSchema = z.object({ enabled: z.boolean() });

const issueReportingSchema = z.object({ publicFormEnabled: z.boolean() });

/**
 * The acting person, or a fault.
 *
 * Not `?? ""`: an empty id would be used as a database key and the caller would
 * be told "person not found", which describes the register rather than the
 * request that is actually broken. The global guard attaches a principal to
 * every non-public route or rejects it, so reaching this throw means the guard
 * stopped doing that and a 500 naming the guard is the honest answer.
 */
function requirePersonId(request: RequestWithPrincipal): string {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error("The authorization guard did not attach a principal.");
  }
  return principal.personId;
}

const profileSchema = z.object({
  preferredLocale: z.enum(SUPPORTED_LOCALES),
});

/**
 * The logo slot named in the path, or a 404.
 *
 * Two slots exist and neither is a value a caller invents: "light" is the
 * housing cooperative's mark and "dark" is its variant for the dark band.
 */
function logoSlot(value: string): LogoSlot {
  if (value === "light" || value === "dark") {
    return value;
  }
  throw new NotFoundException("No such logo slot.");
}

/**
 * Reading the instance's settings.
 *
 * association:read rather than association:manage: the board answers for the
 * retention policy and for whether the instance accepts sign-up requests, so it
 * has to be able to see them, while changing them stays with an admin
 * (plan section 4.3). The response never carries the SMTP password.
 */
@Controller("api/settings")
@RequireCapability("association:read")
export class SettingsReadController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  async read(): Promise<InstanceSettings> {
    return this.settings.read();
  }
}

/**
 * Changing the instance's settings. Admin only.
 *
 * The capability sits on the class so a route added here later inherits it
 * rather than being open by omission.
 */
@Controller("api/settings")
@RequireCapability("association:manage")
export class SettingsWriteController {
  constructor(private readonly settings: SettingsService) {}

  @Put("housing-cooperative")
  async updateHousingCooperative(
    @Body() body: unknown,
  ): Promise<HousingCooperativeSettings> {
    return this.settings.updateHousingCooperative(
      housingCooperativeSchema.parse(body),
    );
  }

  @Put("branding")
  async updateBranding(@Body() body: unknown): Promise<BrandingSettings> {
    return this.settings.updateBranding(brandingSchema.parse(body));
  }

  /**
   * Uploads the housing cooperative's mark, or its dark-surface variant.
   *
   * The slot is a path segment out of a fixed pair rather than a body field, so
   * an unrecognised value is a 404 from the router instead of a decision this
   * handler has to make.
   */
  @Put("branding/logo/:slot")
  async uploadLogo(
    @Param("slot") slot: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<BrandingSettings> {
    const file = await readSingleFile(request).catch((cause: unknown) => {
      if (isTooLarge(cause)) {
        throw new MediaError("The file is larger than allowed.", "too-large");
      }
      throw cause;
    });

    if (file === null) {
      throw new MediaError("The request carried no file.", "no-file");
    }

    return this.settings.updateLogo({
      slot: logoSlot(slot),
      bytes: file.bytes,
      fileName: file.fileName,
      actorPersonId: requirePersonId(request),
    });
  }

  @Delete("branding/logo/:slot")
  async removeLogo(
    @Param("slot") slot: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<BrandingSettings> {
    return this.settings.removeLogo(logoSlot(slot), requirePersonId(request));
  }

  @Put("smtp")
  async updateSmtp(@Body() body: unknown): Promise<SmtpSettingsView> {
    return this.settings.updateSmtp(smtpSchema.parse(body));
  }

  @Post("smtp/test")
  async testSmtp(
    @Req() request: RequestWithPrincipal,
  ): Promise<{ sentTo: string; host: string }> {
    return this.settings.sendTestMessage(requirePersonId(request));
  }

  @Put("retention")
  async updateRetention(
    @Body() body: unknown,
  ): Promise<{ daysAfterMoveOut: number }> {
    return this.settings.updateRetention(retentionSchema.parse(body));
  }

  @Put("self-signup")
  async updateSelfSignup(@Body() body: unknown): Promise<{ enabled: boolean }> {
    return this.settings.updateSelfSignup(selfSignupSchema.parse(body));
  }

  @Put("issue-reporting")
  async updateIssueReporting(
    @Body() body: unknown,
  ): Promise<{ publicFormEnabled: boolean }> {
    return this.settings.updateIssueReporting(issueReportingSchema.parse(body));
  }
}

/**
 * The signed-in person's own preferences.
 *
 * A separate controller because this is the one settings route a resident may
 * use: self:manage, on their own record only. The person id comes from the
 * session rather than the body, so nobody can change someone else's profile by
 * naming them.
 */
@Controller("api/settings/profile")
@RequireCapability("self:manage")
export class ProfileSettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Put()
  async updateProfile(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<{ preferredLocale: string }> {
    return this.settings.updateOwnProfile(
      requirePersonId(request),
      profileSchema.parse(body),
    );
  }
}
