import { Controller, Get } from "@nestjs/common";

import { Public } from "../authorization/public.decorator";

export interface HealthStatus {
  status: "ok";
}

@Public()
@Controller("health")
export class HealthController {
  @Get()
  getHealth(): HealthStatus {
    return { status: "ok" };
  }
}
