import { Module } from "@nestjs/common";

import { AddressController, ApartmentController } from "./address.controller";
import { AddressService } from "./address.service";

@Module({
  controllers: [AddressController, ApartmentController],
  providers: [AddressService],
  exports: [AddressService],
})
export class AddressesModule {}
