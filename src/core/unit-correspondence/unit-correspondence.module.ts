import { Global, Module } from '@nestjs/common';
import { UnitCorrespondence } from './unit-correspondence';
import { UnitCorrespondenceController } from './unit-correspondence.controller';
import { UnitCorrespondenceService } from './unit-correspondence.service';

/** A unit's correspondence (ADR 0080): the domains register their sources. */
@Global()
@Module({
  controllers: [UnitCorrespondenceController],
  providers: [UnitCorrespondence, UnitCorrespondenceService],
  exports: [UnitCorrespondence],
})
export class UnitCorrespondenceModule {}
