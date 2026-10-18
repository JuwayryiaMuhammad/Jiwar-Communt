import { Injectable, type OnModuleInit } from '@nestjs/common';
import { firstNameOf } from '../../core/common/http/personal';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';

const ofDate = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The children section of a personal-data export (ADR 0054), `children/`:
 * the exit controls the account turned on (the child by first name, the
 * switches, when), and the escorts it added (the kind, the outside person's
 * name and phone as it typed them while kept, the validity). Never a card,
 * a code, a birth date, a document or a photo, and never the exits: they
 * are the household's records, not the account's.
 */
@Injectable()
export class ChildExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
  ) {}

  onModuleInit(): void {
    this.sections.register('children', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    const me = s.accountId;
    const d = await this.tenantTx.withTenantTx(async (tx) => {
      const controls = await tx.childControl.findMany({
        where: { turnedOnById: me },
        orderBy: [{ turnedOnAt: 'asc' }, { id: 'asc' }],
      });
      const escorts = await tx.childEscort.findMany({
        where: { createdById: me },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const memberIds = [...new Set(controls.map((c) => c.memberId))];
      const members = new Map(
        (memberIds.length
          ? await tx.householdMember.findMany({
              where: { id: { in: memberIds } },
              select: { id: true, fullName: true },
            })
          : []
        ).map((m) => [m.id, firstNameOf(m.fullName)]),
      );
      const units = new Map(
        (
          await tx.unit.findMany({
            where: {
              id: {
                in: [
                  ...new Set([
                    ...controls.map((c) => c.unitId),
                    ...escorts.map((e) => e.unitId),
                  ]),
                ],
              },
            },
            select: { id: true, code: true },
          })
        ).map((u) => [u.id, u.code]),
      );
      return { controls, escorts, members, units };
    });
    yield {
      path: 'children/controls.json',
      json: d.controls.map((c) => ({
        controlId: c.id,
        unitCode: d.units.get(c.unitId) ?? null,
        memberId: c.memberId,
        firstName: d.members.get(c.memberId) ?? null,
        mayLeaveAlone: c.mayLeaveAlone,
        notifyPickups: c.notifyPickups,
        turnedOnAt: c.turnedOnAt,
        endedAt: c.endedAt,
        endReason: c.endReason,
      })),
    };
    yield {
      path: 'children/escorts.json',
      json: d.escorts.map((e) => ({
        escortId: e.id,
        controlId: e.controlId,
        unitCode: d.units.get(e.unitId) ?? null,
        kind: e.kind,
        fullName: e.fullName,
        phone: e.phone,
        validFrom: ofDate(e.validFrom),
        validUntil: e.validUntil ? ofDate(e.validUntil) : null,
        schedule: e.schedule,
        revokedAt: e.revokedAt,
        revokeReason: e.revokeReason,
        createdAt: e.createdAt,
      })),
    };
  }
}
