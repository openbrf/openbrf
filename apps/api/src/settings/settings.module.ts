import { Module } from "@nestjs/common";

import {
  ProfileSettingsController,
  SettingsReadController,
  SettingsWriteController,
} from "./settings.controller";
import { SettingsService } from "./settings.service";

@Module({
  controllers: [
    SettingsReadController,
    SettingsWriteController,
    ProfileSettingsController,
  ],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
