import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma, type EnergyTariff } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dateColumn, type LocalDate } from '../schedules/local-dates';
import type { MeterKind } from './meter-rules';

export const TARIFF_RESOURCE = 'energy_tariff';
/** Tariffs one kind lists at most: a compound changes them a few times a year. */
export const TARIFFS_LISTED = 200;

/**
 * What a unit of a kind costs from a day on (ADR 0066): added with
 * `energy.manage`, never edited — a later day's tariff takes over. One a
 * kind and day (DUPLICATE_RESOURCE on `effectiveOn`).
 */
@Injectable()
export class TariffsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(TARIFF_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const t = await tx.energyTariff.findUnique({ where: { id } });
        if (!t)
          throw appError.notFound(
            ErrorCode.ENERGY_TARIFF_NOT_FOUND,
            'Tariff not found',
          );
        return t;
      }),
    );
  }

  list(q: { kind?: MeterKind }): Promise<EnergyTariff[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.energyTariff.findMany({
        where: q.kind ? { kind: q.kind } : {},
        orderBy: [{ kind: 'asc' }, { effectiveOn: 'desc' }],
        take: TARIFFS_LISTED,
      }),
    );
  }

  create(input: {
    kind: MeterKind;
    effectiveOn: LocalDate;
    pricePerUnit: string;
  }): Promise<EnergyTariff> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: TARIFF_RESOURCE, id });
      const tariff = await tx.energyTariff.create({
        data: {
          id,
          tenantId: this.ctx.tenantId,
          kind: input.kind,
          effectiveOn: dateColumn(input.effectiveOn),
          pricePerUnit: new Prisma.Decimal(input.pricePerUnit),
          createdById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'energy_tariff.created',
        targetId: id,
        metadata: {
          kind: input.kind,
          effectiveOn: input.effectiveOn,
          pricePerUnit: tariff.pricePerUnit.toFixed(4),
        },
      });
      return tariff;
    });
  }
}
