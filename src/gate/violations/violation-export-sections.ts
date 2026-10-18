import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityGatePort } from '../../community';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { safetyReference } from '../safety/safety-rules';
import { dayOf } from '../vehicles/vehicle-rules';

/**
 * The violations section of a personal-data export (ADR 0053), as the
 * fines' (ADR 0045), `violations/violations.json`: the violations of each
 * unit whose violations it sees (a keeper of its vehicles or who sees its
 * money) and those it appealed, with its own appeal's words; payments
 * only where it sees the unit's money. Never who issued one.
 */
@Injectable()
export class ViolationExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
    private readonly community: CommunityGatePort,
  ) {}

  onModuleInit(): void {
    this.sections.register('violations', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    const me = s.accountId;
    const d = await this.tenantTx.withTenantTx(async (tx) => {
      const keeps = await this.community.unitsWhere(tx, me, 'vehicles');
      const money = await this.community.unitsWhere(tx, me, 'financeView');
      const violations = await tx.unitViolation.findMany({
        where: {
          OR: [
            { unitId: { in: [...new Set([...keeps, ...money])] } },
            { appealedById: me },
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const paidUnits = new Set(money);
      const payable = violations.filter((v) => paidUnits.has(v.unitId));
      const payments = payable.length
        ? await tx.unitViolationPayment.findMany({
            where: { violationId: { in: payable.map((v) => v.id) } },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          })
        : [];
      const codes = await this.community.unitCodes(
        tx,
        violations.map((v) => v.unitId),
      );
      return { violations, payments, paidUnits, codes };
    });
    yield {
      path: 'violations/violations.json',
      json: d.violations.map((v) => ({
        reference: safetyReference('V', v.number),
        unitCode: d.codes.get(v.unitId) ?? null,
        kind: v.kind,
        note: v.note,
        amount: v.amount?.toFixed(2) ?? null,
        currency: v.currency,
        date: dayOf(v.occurredOn),
        status: v.status,
        appeal:
          v.appealedAt && v.appealedById === me
            ? {
                reason: v.appealText,
                appealedAt: v.appealedAt,
                decision: v.appealDecision,
              }
            : null,
        cancelReason: v.cancelReason,
        payments: d.paidUnits.has(v.unitId)
          ? d.payments
              .filter((p) => p.violationId === v.id)
              .map((p) => ({
                kind: p.kind,
                amount: p.amount?.toFixed(2) ?? null,
                receiptNumber: p.receiptNumber,
                paidOn: dayOf(p.paidOn),
                reasonCode: p.reasonCode,
                createdAt: p.createdAt,
              }))
          : null,
        createdAt: v.createdAt,
      })),
    };
  }
}
