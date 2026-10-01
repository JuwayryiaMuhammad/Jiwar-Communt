import { Module } from '@nestjs/common';
import { AccountsModule } from '../core/accounts/accounts.module';
import { GatesController } from './gates/gates.controller';
import { GatesService } from './gates/gates.service';
import { ShiftsController } from './shifts/shifts.controller';
import { ShiftsService } from './shifts/shifts.service';

/**
 * The gate domain (ADR 0028). It imports core freely and the community
 * domain only through src/community/index.ts (ADR 0015).
 */
@Module({
  imports: [AccountsModule],
  controllers: [GatesController, ShiftsController],
  providers: [GatesService, ShiftsService],
})
export class GateModule {}
