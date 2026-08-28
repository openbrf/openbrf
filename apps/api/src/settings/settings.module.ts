import { Module } from "@nestjs/common";

import { MediaModule } from "../media/media.module";
import {
  ProfileSettingsController,
  SettingsReadController,
  SettingsWriteController,
} from "./settings.controller";
import { SettingsService } from "./settings.service";

@Module({
  imports: [MediaModule],
  controllers: [
    SettingsReadController,
    SettingsWriteController,
    ProfileSettingsController,
  ],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
