import { Module } from "@nestjs/common";

import { InvitationsModule } from "../invitations/invitations.module";
import {
  SignupRequestController,
  SignupRequestSubmitController,
} from "./signup-request.controller";
import { SignupRequestService } from "./signup-request.service";

@Module({
  imports: [InvitationsModule],
  controllers: [SignupRequestSubmitController, SignupRequestController],
  providers: [SignupRequestService],
  exports: [SignupRequestService],
})
export class SignupModule {}
