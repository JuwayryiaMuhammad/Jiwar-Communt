import { Injectable } from '@nestjs/common';
import type { Specialty } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { categoryNotFound } from '../categories/categories.service';
import { TicketAccess } from '../tickets/ticket-access';

export interface SpecialtyInput {
  key: string;
  nameAr: string;
  nameEn: string;
}

export type SpecialtyUpdate = Partial<
  Pick<Specialty, 'nameAr' | 'nameEn' | 'active'>
>;

export const specialtyNotFound = () =>
  appError.notFound(ErrorCode.SPECIALTY_NOT_FOUND, 'Specialty not found');

/** What the audit trail records of a specialty: its own, non-personal fields. */
function audited(s: Specialty) {
  return {
    key: s.key,
    nameAr: s.nameAr,
    nameEn: s.nameEn,
    active: s.active,
  };
}

/**
 * Specialties (ADR 0033): what a technician can do. Like categories they are
 * the compound's own data, never deleted (a category and a technician point
 * at them); a retired one is `active: false` and counts nowhere.
 *
 * Which specialties can handle a category is set by the manager
 * (`maintenance.manage`); which a technician has is set by dispatchers
 * (`tickets.dispatch`), since the supervisor manages the team. Both replace
 * the whole set and audit the keys before and after.
 */
@Injectable()
export class SpecialtiesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly access: TicketAccess,
  ) {}

  /** Every specialty, retired ones included (a compound has a handful). */
  list(): Promise<Specialty[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.specialty.findMany({ orderBy: [{ key: 'asc' }] }),
    );
  }

  /** A duplicate key is DUPLICATE_RESOURCE on `key` (db-constraints). */
  create(input: SpecialtyInput): Promise<Specialty> {
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const specialty = await tx.specialty.create({
        data: {
          id: newId(),
          tenantId,
          key: input.key,
          nameAr: input.nameAr.trim(),
          nameEn: input.nameEn.trim(),
        },
      });
      await this.audit.record(tx, {
        action: 'specialty.created',
        targetId: specialty.id,
        changes: diffChanges(null, audited(specialty), 'specialty.created'),
      });
      return specialty;
    });
  }

  /** The key never changes: apps and reports may hold on to it. */
  update(id: string, input: SpecialtyUpdate): Promise<Specialty> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await tx.specialty.findUnique({ where: { id } });
      if (!before) throw specialtyNotFound();
      const specialty = await tx.specialty.update({
        where: { id },
        data: {
          nameAr: input.nameAr?.trim(),
          nameEn: input.nameEn?.trim(),
          active: input.active,
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(specialty),
        'specialty.updated',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'specialty.updated',
          targetId: id,
          changes,
        });
      return specialty;
    });
  }

  /**
   * Replaces the specialties that can handle a category. The category row
   * is locked first, so two replacements queue instead of interleaving.
   */
  setForCategory(categoryId: string, specialtyIds: string[]): Promise<void> {
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM ticket_categories WHERE id = ${categoryId}::uuid FOR UPDATE`;
      if (!locked.length) throw categoryNotFound();
      const wanted = await this.activeSpecialties(tx, specialtyIds);
      const before = await tx.categorySpecialty.findMany({
        where: { categoryId },
        include: { specialty: { select: { key: true } } },
      });
      const keep = new Set(specialtyIds);
      const gone = before.filter((l) => !keep.has(l.specialtyId));
      if (gone.length)
        await tx.categorySpecialty.deleteMany({
          where: {
            categoryId,
            specialtyId: { in: gone.map((l) => l.specialtyId) },
          },
        });
      const had = new Set(before.map((l) => l.specialtyId));
      const added = specialtyIds.filter((id) => !had.has(id));
      if (added.length)
        await tx.categorySpecialty.createMany({
          data: added.map((specialtyId) => ({
            tenantId,
            categoryId,
            specialtyId,
          })),
        });
      await this.auditSet(
        tx,
        'ticket_category.specialties_changed',
        categoryId,
        before.map((l) => l.specialty.key),
        wanted.map((s) => s.key),
      );
    });
  }

  /**
   * Replaces a technician's specialties (dispatchers). A technician is an
   * active staff account holding tickets.work, else TECHNICIAN_NOT_FOUND.
   * Their account row is locked against other writers of their data; a row
   * that leaves the set is switched off, not deleted.
   */
  setForTechnician(
    technicianId: string,
    specialtyIds: string[],
  ): Promise<void> {
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockTechnician(tx, technicianId, 'write');
      const wanted = await this.activeSpecialties(tx, specialtyIds);
      const rows = await tx.technicianSpecialty.findMany({
        where: { accountId: technicianId },
        include: { specialty: { select: { key: true } } },
      });
      const keep = new Set(specialtyIds);
      const before = rows.filter((r) => r.active).map((r) => r.specialty.key);
      for (const row of rows)
        if (row.active && !keep.has(row.specialtyId))
          await tx.technicianSpecialty.update({
            where: {
              tenantId_accountId_specialtyId: {
                tenantId,
                accountId: technicianId,
                specialtyId: row.specialtyId,
              },
            },
            data: { active: false },
          });
      for (const specialtyId of specialtyIds)
        await tx.technicianSpecialty.upsert({
          where: {
            tenantId_accountId_specialtyId: {
              tenantId,
              accountId: technicianId,
              specialtyId,
            },
          },
          create: { tenantId, accountId: technicianId, specialtyId },
          update: { active: true },
        });
      await this.auditSet(
        tx,
        'technician.specialties_changed',
        technicianId,
        before,
        wanted.map((s) => s.key),
      );
    });
  }

  /**
   * The specialties named, all active and of this compound (RLS), or a field
   * error per id that is not: one answer for unknown, retired and foreign.
   */
  private async activeSpecialties(
    tx: TenantTxClient,
    ids: string[],
  ): Promise<Specialty[]> {
    const rows = await tx.specialty.findMany({
      where: { id: { in: ids }, active: true },
    });
    const found = new Set(rows.map((r) => r.id));
    const fields: FieldError[] = ids.flatMap((id, i) =>
      found.has(id)
        ? []
        : [
            {
              field: `specialtyIds.${i}`,
              code: FieldErrorCode.SPECIALTY_NOT_AVAILABLE,
            },
          ],
    );
    if (fields.length)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Unknown specialty',
        { fields },
      );
    return rows;
  }

  private async auditSet(
    tx: TenantTxClient,
    action:
      'ticket_category.specialties_changed' | 'technician.specialties_changed',
    targetId: string,
    before: string[],
    after: string[],
  ): Promise<void> {
    const changes = diffChanges(
      { specialties: [...before].sort() },
      { specialties: [...after].sort() },
      action,
    );
    if (Object.keys(changes).length)
      await this.audit.record(tx, { action, targetId, changes });
  }
}
