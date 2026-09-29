import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { AppClsStore } from '../common/cls/app-cls';
import { BASE_PRISMA, type BasePrisma } from './base-prisma';
import { createTenantClient, type TenantClient } from './tenant-extension';

/**
 * Entry point for single-statement tenant queries:
 * `prisma.tenant.unit.findMany()`. Every operation runs in its own
 * transaction with the request tenant set first (ADR 0005).
 */
@Injectable()
export class PrismaService {
  readonly tenant: TenantClient;

  constructor(
    @Inject(BASE_PRISMA) base: BasePrisma,
    cls: ClsService<AppClsStore>,
  ) {
    this.tenant = createTenantClient(base.client, cls);
  }
}
