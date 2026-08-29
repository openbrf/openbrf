import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { z } from "zod";

import { RequireCapability } from "../authorization/require-capability.decorator";
import { type MenuItemView, MenuWriteService } from "./menu-write.service";

/**
 * The board's own screen for the site menu, over HTTP.
 *
 * Every route needs site:manage, declared on the class so a route added later
 * inherits the restriction instead of being open by omission - the same shape
 * the pages controller has, and separate from the public website's controller
 * for the same reason: the website is @Public() in the strongest sense, and a
 * class carrying both would make that a per-route detail.
 */

/*
 * Strict, like the block schema next door and for the same reason: a field the
 * server does not know is a client saying something this version cannot honour,
 * and answering "saved" to it would be answering for a menu entry nobody
 * arranged. A typo is a refusal rather than a silent no-op.
 */
const itemSchema = z.strictObject({
  kind: z.enum(["PAGE", "GENERATED", "EXTERNAL"]),
  /** Empty is allowed: a page entry then takes the page's own title. */
  label: z.string().trim().max(120).default(""),
  pageId: z.string().min(1).max(64).optional(),
  generatedKey: z.string().min(1).max(64).optional(),
  url: z.string().trim().max(2048).optional(),
  parentId: z.string().min(1).max(64).nullable().optional(),
});

const orderSchema = z.strictObject({
  /** Null orders the top level; an id orders what hangs under that entry. */
  parentId: z.string().min(1).max(64).nullable().default(null),
  ids: z.array(z.string().min(1).max(64)).max(200),
});

@Controller("api/site/menu")
@RequireCapability("site:manage")
export class MenuAdminController {
  constructor(private readonly menu: MenuWriteService) {}

  @Get()
  async list(): Promise<MenuItemView[]> {
    return this.menu.list();
  }

  @Post()
  async create(@Body() body: unknown): Promise<MenuItemView> {
    return this.menu.create(itemSchema.parse(body));
  }

  /**
   * Puts one level in the order the ids arrive in.
   *
   * Declared above the parameter routes so the word "order" is never read as
   * an entry's id.
   */
  @Post("order")
  async reorder(@Body() body: unknown): Promise<MenuItemView[]> {
    const input = orderSchema.parse(body);
    return this.menu.reorder(input.parentId, input.ids);
  }

  @Put(":id")
  async update(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<MenuItemView> {
    return this.menu.update(id, itemSchema.parse(body));
  }

  @Delete(":id")
  async remove(@Param("id") id: string): Promise<void> {
    await this.menu.remove(id);
  }
}
