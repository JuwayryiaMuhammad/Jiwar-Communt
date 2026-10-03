import { Module } from '@nestjs/common';
import { CommunityMaintenancePortModule } from '../community';
import { MaintenanceProvisioning } from './provisioning';

/**
 * The maintenance domain (ADR 0032). It imports core freely and the
 * community domain only through src/community/index.ts (ADR 0015); never
 * the gate.
 */
@Module({
  imports: [CommunityMaintenancePortModule],
  providers: [MaintenanceProvisioning],
})
export class MaintenanceModule {}
