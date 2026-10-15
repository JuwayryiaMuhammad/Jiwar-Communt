import { Injectable } from '@nestjs/common';
import { appError, ErrorCode } from '../../core/common/errors';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { PlatformStepUpService } from '../../core/platform/platform-step-up.service';
import type { SetGatewayDto } from './dto/gateway.dto';
import { GatewayService } from './gateway.service';
import type { GatewayView } from './views/gateway.view';

/**
 * The platform's side of a compound's gateway (ADR 0046). A platform
 * request has no tenant of its own, so the compound comes from the path
 * and is opened with runInTenantUnsafe (this file is named in
 * eslint.config.mjs); the platform audit row commits in the same
 * transaction, and so does the step-up it spends.
 */
@Injectable()
export class PlatformGatewayService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly gateway: GatewayService,
    private readonly stepUp: PlatformStepUpService,
  ) {}

  view(tenantId: string): Promise<GatewayView> {
    return this.in(tenantId, (tx) => this.gateway.view(tx, tenantId));
  }

  set(tenantId: string, dto: SetGatewayDto): Promise<GatewayView> {
    return this.in(tenantId, async (tx) => {
      await this.stepUp.consume(tx);
      await this.gateway.set(tx, tenantId, dto, 'platform');
      return this.gateway.view(tx, tenantId);
    });
  }

  setDisabled(tenantId: string, disabled: boolean): Promise<GatewayView> {
    return this.in(tenantId, async (tx) => {
      await this.stepUp.consume(tx);
      await this.gateway.setPlatformDisabled(tx, tenantId, disabled);
      return this.gateway.view(tx, tenantId);
    });
  }

  private async in<T>(
    tenantId: string,
    fn: (tx: TenantTxClient) => Promise<T>,
  ): Promise<T> {
    const tenant = await this.globalDb.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      throw appError.notFound(ErrorCode.TENANT_NOT_FOUND, 'Compound not found');
    }
    return this.tenantTx.runInTenantUnsafe(tenantId, fn);
  }
}
