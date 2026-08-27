import { Module } from "@nestjs/common";

import {
  InvitationAcceptController,
  InvitationController,
} from "./invitation.controller";
import { InvitationService } from "./invitation.service";

@Module({
  controllers: [InvitationController, InvitationAcceptController],
  providers: [InvitationService],
  exports: [InvitationService],
})
export class InvitationsModule {}
