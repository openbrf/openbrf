import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import {
  DATA_SUBJECT_CATEGORIES,
  PERSONAL_DATA_CATEGORIES,
} from "@openbrf/shared";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { actingPersonId } from "../registers/acting-person";
import { BreachService, type BreachView } from "./breach.service";
import {
  ProcessorAgreementService,
  type ProcessorView,
} from "./processor-agreement.service";
import { ProcessorFactsService } from "./processor-facts.service";
import {
  ProcessingActivityService,
  type ProcessingActivityView,
  type ProcessingRecord,
} from "./processing-activity.service";

/**
 * Every free text the board types is bounded here, at the edge, and scanned for
 * a personal identity number in the service behind it.
 *
 * The lengths are what a board actually writes: a title is a line, a
 * description is a paragraph or two, a ground is a sentence explaining a
 * decision. They exist so a record cannot become a place to paste a database
 * dump into.
 */
const recordSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(4000),
  occurredAt: z.iso.datetime().optional(),
  discoveredAt: z.iso.datetime(),
  personalDataCategories: z
    .array(z.enum(PERSONAL_DATA_CATEGORIES))
    .max(PERSONAL_DATA_CATEGORIES.length),
  dataSubjectCategories: z
    .array(z.enum(DATA_SUBJECT_CATEGORIES))
    .max(DATA_SUBJECT_CATEGORIES.length),
  dataDescription: z.string().trim().min(1).max(2000),
  affectedCount: z.number().int().min(0).optional(),
  effects: z.string().trim().min(1).max(2000),
  measures: z.string().trim().min(1).max(2000),
  subjectPersonIds: z.array(z.string().trim().min(1).max(64)).max(500),
});

const updateSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).max(4000).optional(),
  occurredAt: z.iso.datetime().nullable().optional(),
  discoveredAt: z.iso.datetime().optional(),
  personalDataCategories: z.array(z.enum(PERSONAL_DATA_CATEGORIES)).optional(),
  dataSubjectCategories: z.array(z.enum(DATA_SUBJECT_CATEGORIES)).optional(),
  dataDescription: z.string().trim().min(1).max(2000).optional(),
  affectedCount: z.number().int().min(0).nullable().optional(),
  effects: z.string().trim().min(1).max(2000).optional(),
  measures: z.string().trim().min(1).max(2000).optional(),
  imyNotifiedAt: z.iso.datetime().nullable().optional(),
  imyReference: z.string().trim().max(100).nullable().optional(),
  subjectsInformedAt: z.iso.datetime().nullable().optional(),
  delayReasons: z.string().trim().max(1000).nullable().optional(),
});

const decisionSchema = z.object({
  risk: z.enum(["UNLIKELY", "LIKELY", "HIGH"]),
  imyNotificationRequired: z.boolean(),
  imyDecisionGround: z.string().trim().min(1).max(1000),
  imyNotifiedAt: z.iso.datetime().nullable().optional(),
  imyReference: z.string().trim().max(100).nullable().optional(),
  delayReasons: z.string().trim().max(1000).nullable().optional(),
  subjectsInformationRequired: z.boolean(),
  subjectsDecisionGround: z.string().trim().max(1000).nullable().optional(),
});

/** One processing as the board writes it (GDPR art. 30(1)(b)-(g)). */
const activitySchema = z.object({
  name: z.string().trim().min(1).max(200),
  purpose: z.string().trim().min(1).max(2000),
  legalBasis: z.enum([
    "CONSENT",
    "CONTRACT",
    "LEGAL_OBLIGATION",
    "VITAL_INTERESTS",
    "PUBLIC_TASK",
    "LEGITIMATE_INTEREST",
  ]),
  legalBasisNote: z.string().trim().max(1000).nullable().optional(),
  dataSubjectCategories: z.array(z.enum(DATA_SUBJECT_CATEGORIES)),
  personalDataCategories: z.array(z.enum(PERSONAL_DATA_CATEGORIES)),
  recipients: z.string().trim().max(1000).nullable().optional(),
  thirdCountryTransfer: z.boolean(),
  thirdCountrySafeguards: z.string().trim().max(1000).nullable().optional(),
  retention: z.string().trim().min(1).max(1000),
  securityMeasures: z.string().trim().max(2000).nullable().optional(),
});

/** How a recipient is classified, and the agreement where there is one. */
const agreementSchema = z.object({
  classification: z.enum([
    "PROCESSOR",
    "NOT_A_PROCESSOR",
    "INDEPENDENT_CONTROLLER",
  ]),
  status: z.enum(["IN_PLACE", "PENDING"]).nullable().optional(),
  counterparty: z.string().trim().max(200).nullable().optional(),
  reference: z.string().trim().max(200).nullable().optional(),
  signedOn: z.iso.date().nullable().optional(),
  termsConfirmed: z.boolean().nullable().optional(),
  subProcessorsAuthorised: z.boolean().nullable().optional(),
  subProcessorNote: z.string().trim().max(1000).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
});

const endSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

const subjectSchema = z.object({
  personId: z.string().trim().min(1).max(64),
});

function toDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value === null ? null : new Date(value);
}

/**
 * The association's own data protection records.
 *
 * Gated on `dataProtection:manage`, which is the board's: the association is
 * the controller and GDPR art. 5(2) makes it answerable for demonstrating that
 * it processes lawfully. What one named person asked about their own data is
 * gated on the address book instead, in its own controller - that is a decision
 * about a person rather than about the association.
 */
@Controller("api/data-protection")
@RequireCapability("dataProtection:manage")
export class DataProtectionController {
  constructor(
    private readonly breaches: BreachService,
    private readonly processing: ProcessingActivityService,
    private readonly processors: ProcessorAgreementService,
    private readonly facts: ProcessorFactsService,
  ) {}

  @Get("processors")
  async listProcessors(): Promise<ProcessorView[]> {
    return this.processors.list(await this.facts.read());
  }

  @Put("processor-agreements/:processorKey")
  @HttpCode(200)
  async recordProcessorAgreement(
    @Req() request: RequestWithPrincipal,
    @Param("processorKey") processorKey: string,
    @Body() body: unknown,
  ): Promise<ProcessorView> {
    const input = agreementSchema.parse(body);
    return this.processors.record(
      processorKey,
      {
        ...input,
        signedOn: input.signedOn == null ? null : new Date(input.signedOn),
        actorPersonId: actingPersonId(request),
      },
      await this.facts.read(),
    );
  }

  @Post("processor-agreements/external")
  async recordExternalProcessor(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<ProcessorView> {
    const input = agreementSchema.parse(body);
    return this.processors.recordExternal(
      {
        ...input,
        signedOn: input.signedOn == null ? null : new Date(input.signedOn),
        actorPersonId: actingPersonId(request),
      },
      await this.facts.read(),
    );
  }

  @Post("processor-agreements/:agreementId/end")
  @HttpCode(200)
  async endProcessorAgreement(
    @Req() request: RequestWithPrincipal,
    @Param("agreementId") agreementId: string,
    @Body() body: unknown,
  ): Promise<{ ended: true }> {
    const input = endSchema.parse(body);
    await this.processors.end(
      agreementId,
      input.reason ?? null,
      actingPersonId(request),
    );
    return { ended: true };
  }

  @Get("processing-activities")
  async readProcessingRecord(): Promise<ProcessingRecord> {
    return this.processing.read();
  }

  @Post("processing-activities")
  async recordProcessingActivity(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<ProcessingActivityView> {
    const input = activitySchema.parse(body);
    return this.processing.record({
      ...input,
      dataSubjectCategories: [...input.dataSubjectCategories],
      personalDataCategories: [...input.personalDataCategories],
      actorPersonId: actingPersonId(request),
    });
  }

  @Put("processing-activities/:activityId")
  async updateProcessingActivity(
    @Req() request: RequestWithPrincipal,
    @Param("activityId") activityId: string,
    @Body() body: unknown,
  ): Promise<ProcessingActivityView> {
    const input = activitySchema.partial().parse(body);
    return this.processing.update(activityId, {
      ...input,
      dataSubjectCategories: input.dataSubjectCategories
        ? [...input.dataSubjectCategories]
        : undefined,
      personalDataCategories: input.personalDataCategories
        ? [...input.personalDataCategories]
        : undefined,
      actorPersonId: actingPersonId(request),
    });
  }

  @Post("processing-activities/:activityId/end")
  @HttpCode(200)
  async endProcessingActivity(
    @Req() request: RequestWithPrincipal,
    @Param("activityId") activityId: string,
  ): Promise<ProcessingActivityView> {
    return this.processing.end(activityId, actingPersonId(request));
  }

  @Get("breaches")
  async listBreaches(): Promise<BreachView[]> {
    return this.breaches.list();
  }

  @Get("breaches/:breachId")
  async readBreach(@Param("breachId") breachId: string): Promise<BreachView> {
    return this.breaches.read(breachId);
  }

  @Post("breaches")
  async recordBreach(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<BreachView> {
    const input = recordSchema.parse(body);
    return this.breaches.record({
      title: input.title,
      description: input.description,
      occurredAt:
        input.occurredAt === undefined ? null : new Date(input.occurredAt),
      discoveredAt: new Date(input.discoveredAt),
      personalDataCategories: [...input.personalDataCategories],
      dataSubjectCategories: [...input.dataSubjectCategories],
      dataDescription: input.dataDescription,
      affectedCount: input.affectedCount ?? null,
      effects: input.effects,
      measures: input.measures,
      subjectPersonIds: input.subjectPersonIds,
      actorPersonId: actingPersonId(request),
    });
  }

  @Put("breaches/:breachId")
  async updateBreach(
    @Req() request: RequestWithPrincipal,
    @Param("breachId") breachId: string,
    @Body() body: unknown,
  ): Promise<BreachView> {
    const input = updateSchema.parse(body);
    return this.breaches.update(breachId, {
      title: input.title,
      description: input.description,
      occurredAt: toDate(input.occurredAt),
      discoveredAt:
        input.discoveredAt === undefined
          ? undefined
          : new Date(input.discoveredAt),
      personalDataCategories: input.personalDataCategories
        ? [...input.personalDataCategories]
        : undefined,
      dataSubjectCategories: input.dataSubjectCategories
        ? [...input.dataSubjectCategories]
        : undefined,
      dataDescription: input.dataDescription,
      affectedCount: input.affectedCount,
      effects: input.effects,
      measures: input.measures,
      imyNotifiedAt: toDate(input.imyNotifiedAt),
      imyReference: input.imyReference,
      subjectsInformedAt: toDate(input.subjectsInformedAt),
      delayReasons: input.delayReasons,
      actorPersonId: actingPersonId(request),
    });
  }

  @Post("breaches/:breachId/decision")
  @HttpCode(200)
  async decideBreach(
    @Req() request: RequestWithPrincipal,
    @Param("breachId") breachId: string,
    @Body() body: unknown,
  ): Promise<BreachView> {
    const input = decisionSchema.parse(body);
    return this.breaches.decide(breachId, {
      risk: input.risk,
      imyNotificationRequired: input.imyNotificationRequired,
      imyDecisionGround: input.imyDecisionGround,
      imyNotifiedAt: toDate(input.imyNotifiedAt) ?? null,
      imyReference: input.imyReference ?? null,
      delayReasons: input.delayReasons ?? null,
      subjectsInformationRequired: input.subjectsInformationRequired,
      subjectsDecisionGround: input.subjectsDecisionGround ?? null,
      actorPersonId: actingPersonId(request),
    });
  }

  @Post("breaches/:breachId/subjects")
  async addSubject(
    @Req() request: RequestWithPrincipal,
    @Param("breachId") breachId: string,
    @Body() body: unknown,
  ): Promise<BreachView> {
    const input = subjectSchema.parse(body);
    return this.breaches.addSubject(
      breachId,
      input.personId,
      actingPersonId(request),
    );
  }

  @Post("breaches/:breachId/subjects/:personId/informed")
  @HttpCode(200)
  async markSubjectInformed(
    @Req() request: RequestWithPrincipal,
    @Param("breachId") breachId: string,
    @Param("personId") personId: string,
  ): Promise<BreachView> {
    return this.breaches.markSubjectInformed(
      breachId,
      personId,
      actingPersonId(request),
    );
  }

  @Post("breaches/:breachId/close")
  @HttpCode(200)
  async closeBreach(
    @Req() request: RequestWithPrincipal,
    @Param("breachId") breachId: string,
  ): Promise<BreachView> {
    return this.breaches.close(breachId, actingPersonId(request));
  }
}
