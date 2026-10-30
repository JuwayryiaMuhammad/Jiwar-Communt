import { Module } from '@nestjs/common';
import { MaintenanceGatePort } from './gate-port';

/** The maintenance side of the gate's field safety (ADR 0067), exported through index.ts. */
@Module({
  providers: [MaintenanceGatePort],
  exports: [MaintenanceGatePort],
})
export class MaintenanceGatePortModule {}
