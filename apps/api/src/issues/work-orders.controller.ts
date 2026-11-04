import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { CONTRACTOR_LIMITS, WORK_ORDER_LIMITS } from "@openbrf/shared";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { actingPersonId } from "../registers/acting-person";
import {
  type ContractorChoice,
  ContractorService,
  type ContractorView,
} from "./contractor.service";
import {
  type IssueWorkOrdersView,
  type WorkOrderPreview,
  WorkOrderService,
  type WorkOrderView,
} from "./work-order.service";

/**
 * A work order as a handler writes it. Strict, so a field this route does not
 * read - photographs, a second recipient - is refused rather than dropped and
 * the handler never believes the contractor got something they did not.
 */
const workOrderSchema = z.strictObject({
  contractorId: z.string().min(1).max(64),
  body: z.string().trim().min(1).max(WORK_ORDER_LIMITS.body),
});

/**
 * A sending: the work order and the token of the preview the handler read it
 * in, which the service holds it to.
 */
const sendingSchema = workOrderSchema.extend({
  previewToken: z.string().min(1).max(128),
});

/** An optional one-line field: absent, null or empty is none. */
const optionalLine = (max: number) => z.string().trim().max(max).nullish();

const contractorSchema = z.strictObject({
  name: z.string().trim().min(1).max(CONTRACTOR_LIMITS.name),
  trade: z.string().trim().min(1).max(CONTRACTOR_LIMITS.trade),
  phone: optionalLine(CONTRACTOR_LIMITS.phone),
  email: z
    .union([
      z.literal(""),
      z.string().trim().pipe(z.email().max(CONTRACTOR_LIMITS.email)),
    ])
    .nullish(),
  active: z.boolean().optional(),
});

/**
 * Work orders on the issue queue (decision 23 of the issue module's plan), and
 * the list of contractors a handler chooses from.
 *
 * Under issues:handle on the queue's own base path, so a work order is reached
 * by exactly who reaches the issue; whether the reader handles that issue is
 * answered inside `WorkOrderService`, as every queue route's is. A controller
 * of its own beside `IssueQueueController` rather than more routes on it,
 * because a work order is the one act on an issue that leaves the instance.
 */
@Controller("api/issue-queue")
@RequireCapability("issues:handle")
export class IssueWorkOrderController {
  constructor(
    private readonly workOrders: WorkOrderService,
    private readonly contractors: ContractorService,
  ) {}

  /** The contractors on the list and switched on, by name. */
  @Get("contractors")
  async contractorChoices(): Promise<ContractorChoice[]> {
    return this.contractors.choices();
  }

  /** The record of what was sent contractors about the issue. */
  @Get(":id/work-orders")
  async list(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<IssueWorkOrdersView> {
    return this.workOrders.list(actingPersonId(request), id);
  }

  /**
   * The mail a work order would be, stored nowhere and sent to nobody. A POST
   * because it carries the text, which has no place in an address or a log.
   */
  @Post(":id/work-orders/preview")
  @HttpCode(200)
  async preview(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<WorkOrderPreview> {
    return this.workOrders.preview(
      actingPersonId(request),
      id,
      workOrderSchema.parse(body),
    );
  }

  @Post(":id/work-orders")
  @HttpCode(201)
  async send(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<WorkOrderView> {
    return this.workOrders.send(
      actingPersonId(request),
      id,
      sendingSchema.parse(body),
    );
  }
}

/**
 * The board's list of contractors. issues:configure, the capability the issue
 * types are kept under: which firms the association hires is the board's call
 * about its building, as the categories of its problems are.
 */
@Controller("api/contractors")
@RequireCapability("issues:configure")
export class ContractorAdminController {
  constructor(private readonly contractors: ContractorService) {}

  @Get()
  async list(): Promise<ContractorView[]> {
    return this.contractors.list();
  }

  @Post()
  @HttpCode(201)
  async create(
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<ContractorView> {
    return this.contractors.create(
      contractorSchema.parse(body),
      actingPersonId(request),
    );
  }

  @Put(":id")
  async update(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() request: RequestWithPrincipal,
  ): Promise<ContractorView> {
    return this.contractors.update(
      id,
      contractorSchema.parse(body),
      actingPersonId(request),
    );
  }

  /**
   * Takes a contractor off the list and erases them from the work orders sent
   * them. The work orders stay on the issues, without a recipient.
   */
  @Delete(":id")
  @HttpCode(204)
  async remove(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<void> {
    await this.contractors.remove(id, actingPersonId(request));
  }
}
