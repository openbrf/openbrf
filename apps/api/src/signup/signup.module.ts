import { Module } from "@nestjs/common";

import { InvitationsModule } from "../invitations/invitations.module";
import { MovesModule } from "../moves/moves.module";
import {
  SignupRequestController,
  SignupRequestStateController,
  SignupRequestSubmitController,
} from "./signup-request.controller";
import { SignupRequestService } from "./signup-request.service";

@Module({
  imports: [InvitationsModule, MovesModule],
  controllers: [
    SignupRequestSubmitController,
    SignupRequestStateController,
    SignupRequestController,
  ],
  providers: [SignupRequestService],
  exports: [SignupRequestService],
})
export class SignupModule {}
