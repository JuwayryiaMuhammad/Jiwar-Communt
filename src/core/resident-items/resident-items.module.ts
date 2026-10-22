import { Global, Module } from '@nestjs/common';
import { ResidentItemsController } from './resident-items.controller';
import { ResidentItems } from './resident-items';
import { ResidentItemsService } from './resident-items.service';

/** The resident's lists (ADR 0058): the domains register their sources. */
@Global()
@Module({
  controllers: [ResidentItemsController],
  providers: [ResidentItems, ResidentItemsService],
  exports: [ResidentItems],
})
export class ResidentItemsModule {}
