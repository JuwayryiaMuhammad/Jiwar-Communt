import { Injectable } from '@nestjs/common';
import type { FloorPlan } from '@prisma/client';
import { CommunityFacilitiesPort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
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
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { FacilitiesAccess } from '../access';
import { dbNow } from '../db-clock';
import { fraction, ofDecimal, SCALE, units } from './fractions';

/** Hotspots on one plan, at most. */
export const MAX_HOTSPOTS = 500;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HotspotInput extends Box {
  unitId: string;
}

export interface HotspotRead extends Box {
  unitId: string;
  unitCode: string;
  /** The unit is no longer on the plan's building and floor. */
  misplaced: boolean;
}

export interface FloorPlanSummary {
  id: string;
  buildingId: string;
  buildingName: string;
  floor: number;
  hotspots: number;
  updatedAt: Date;
}

export interface FloorPlanRead extends FloorPlanSummary {
  image: PresignedRead | null;
  units: HotspotRead[];
}

/** A resident's plan: the image and their own unit's box, nothing else. */
export interface UnitFloorPlanRead {
  buildingName: string;
  floor: number;
  image: PresignedRead | null;
  unitCode: string;
  /** Null when the unit has no hotspot on its floor's plan. */
  box: Box | null;
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

export const floorPlanNotFound = () =>
  appError.notFound(ErrorCode.FLOOR_PLAN_NOT_FOUND, 'Floor plan not found');

const unitNotFound = () =>
  appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');

/**
 * The buildings' floor plans (ADR 0084): one image (purpose `floor_plan`)
 * per building of the register (ADR 0072) and floor, with a box for each
 * of the floor's units, kept with `spaces.manage`. The boxes are fractions
 * of the image, inside it (HOTSPOT_OUTSIDE_IMAGE, and a CHECK); a unit is
 * boxed on the plan of its own building and floor only (UNIT_NOT_ON_FLOOR),
 * on one plan at most: boxing it here drops a stale box it kept on another
 * floor's plan. A unit moved since its box was drawn is shown so to the
 * staff (`misplaced`), and its resident sees their own floor's plan.
 *
 * Locks: the caller's account; a new plan, the building's advisory lock
 * (one plan a floor); a plan's change, its row FOR UPDATE.
 */
@Injectable()
export class FloorPlansService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly access: FacilitiesAccess,
    private readonly files: FilesService,
    private readonly community: CommunityFacilitiesPort,
  ) {}

  list(buildingId?: string): Promise<FloorPlanSummary[]> {
    return this.tenantTx.withTenantTx((tx) => this.summaries(tx, buildingId));
  }

  get(id: string): Promise<FloorPlanRead> {
    return this.tenantTx.withTenantTx((tx) => this.readIn(tx, id));
  }

  create(input: {
    buildingId: string;
    floor: number;
    fileId: string;
  }): Promise<FloorPlanRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`floor-plan:${this.ctx.txTenantId}:${input.buildingId}`}))`;
      if (
        !(await tx.building.findUnique({
          where: { id: input.buildingId },
          select: { id: true },
        }))
      )
        throw invalid([
          { field: 'buildingId', code: FieldErrorCode.BUILDING_NOT_FOUND },
        ]);
      const taken = await tx.floorPlan.findFirst({
        where: { buildingId: input.buildingId, floor: input.floor },
        select: { id: true },
      });
      if (taken)
        throw appError.conflict(
          ErrorCode.FLOOR_PLAN_EXISTS,
          'This floor has its plan already',
          { params: { planId: taken.id } },
        );
      const file = await this.files.claim(tx, input.fileId, 'floor_plan');
      if (!file)
        throw invalid([
          { field: 'fileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
        ]);
      await this.files.attach(tx, file);
      const now = await dbNow(tx);
      const plan = await tx.floorPlan.create({
        data: {
          id: newId(),
          tenantId: this.ctx.tenantId,
          buildingId: input.buildingId,
          floor: input.floor,
          fileId: file.id,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'floor_plan.created',
        targetId: plan.id,
        metadata: { buildingId: plan.buildingId, floor: plan.floor },
      });
      return this.readIn(tx, plan.id);
    });
  }

  setImage(id: string, fileId: string): Promise<FloorPlanRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const plan = await this.lock(tx, id);
      const file = await this.files.claim(tx, fileId, 'floor_plan');
      if (!file)
        throw invalid([
          { field: 'fileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
        ]);
      await this.files.attach(tx, file);
      await tx.floorPlan.update({ where: { id }, data: { fileId: file.id } });
      await this.files.markDeleted(
        tx,
        { id: plan.fileId, purpose: 'floor_plan' },
        'replaced',
      );
      await this.audit.record(tx, {
        action: 'floor_plan.image_set',
        targetId: id,
        metadata: { fileId: file.id, replacedFileId: plan.fileId },
      });
      return this.readIn(tx, id);
    });
  }

  /** Replaces every box of the plan at once. */
  setHotspots(
    id: string,
    input: readonly HotspotInput[],
  ): Promise<FloorPlanRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const plan = await this.lock(tx, id);
      const found = new Map(
        (
          await tx.unit.findMany({
            where: { id: { in: [...new Set(input.map((h) => h.unitId))] } },
            select: { id: true, buildingId: true, floor: true },
          })
        ).map((u) => [u.id, u]),
      );
      const fields: FieldError[] = [];
      const seen = new Set<string>();
      const boxes = input.map((h) => ({
        unitId: h.unitId,
        x: units(h.x),
        y: units(h.y),
        width: units(h.width),
        height: units(h.height),
      }));
      boxes.forEach((b, i) => {
        const unit = found.get(b.unitId);
        if (seen.has(b.unitId))
          fields.push({
            field: `hotspots.${i}.unitId`,
            code: FieldErrorCode.DUPLICATE_VALUE,
          });
        else if (!unit)
          fields.push({
            field: `hotspots.${i}.unitId`,
            code: FieldErrorCode.UNIT_NOT_AVAILABLE,
          });
        else if (
          unit.buildingId !== plan.buildingId ||
          unit.floor !== plan.floor
        )
          fields.push({
            field: `hotspots.${i}.unitId`,
            code: FieldErrorCode.UNIT_NOT_ON_FLOOR,
          });
        seen.add(b.unitId);
        if (
          b.width <= 0 ||
          b.height <= 0 ||
          b.x + b.width > SCALE ||
          b.y + b.height > SCALE
        )
          fields.push({
            field: `hotspots.${i}`,
            code: FieldErrorCode.HOTSPOT_OUTSIDE_IMAGE,
          });
      });
      if (fields.length) throw invalid(fields);
      await tx.floorPlanUnit.deleteMany({ where: { planId: id } });
      // A box these units kept on another floor's plan is stale: they are
      // on this floor now.
      if (boxes.length)
        await tx.floorPlanUnit.deleteMany({
          where: { unitId: { in: boxes.map((b) => b.unitId) } },
        });
      if (boxes.length)
        await tx.floorPlanUnit.createMany({
          data: boxes.map((b) => ({
            tenantId: plan.tenantId,
            planId: id,
            unitId: b.unitId,
            x: fraction(b.x),
            y: fraction(b.y),
            width: fraction(b.width),
            height: fraction(b.height),
          })),
        });
      await tx.floorPlan.update({
        where: { id },
        data: { updatedAt: await dbNow(tx) },
      });
      await this.audit.record(tx, {
        action: 'floor_plan.hotspots_set',
        targetId: id,
        metadata: { count: boxes.length },
      });
      return this.readIn(tx, id);
    });
  }

  remove(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const plan = await this.lock(tx, id);
      await tx.floorPlanUnit.deleteMany({ where: { planId: id } });
      await tx.floorPlan.delete({ where: { id } });
      await this.files.markDeleted(
        tx,
        { id: plan.fileId, purpose: 'floor_plan' },
        'withdrawn',
      );
      await this.audit.record(tx, {
        action: 'floor_plan.removed',
        targetId: id,
        metadata: { buildingId: plan.buildingId, floor: plan.floor },
      });
    });
  }

  /**
   * The plan of the unit's own building and floor, for someone with a
   * place in the unit who may see it: the image and the unit's own box.
   * Never another unit's box, code or anything of its occupants.
   */
  forUnit(unitId: string): Promise<UnitFloorPlanRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const caps = await this.community.placeIn(tx, this.ctx.accountId, unitId);
      if (!caps?.unitView) throw unitNotFound();
      const unit = await tx.unit.findUniqueOrThrow({
        where: { id: unitId },
        select: { code: true, buildingId: true, floor: true },
      });
      if (unit.buildingId === null || unit.floor === null)
        throw floorPlanNotFound();
      const plan = await tx.floorPlan.findFirst({
        where: { buildingId: unit.buildingId, floor: unit.floor },
      });
      if (!plan) throw floorPlanNotFound();
      const building = await tx.building.findUniqueOrThrow({
        where: { id: plan.buildingId },
        select: { name: true },
      });
      const spot = await tx.floorPlanUnit.findUnique({
        where: { planId_unitId: { planId: plan.id, unitId } },
      });
      return {
        buildingName: building.name,
        floor: plan.floor,
        image: await this.files.readUrl(tx, plan.fileId),
        unitCode: unit.code,
        box: spot
          ? {
              x: ofDecimal(spot.x),
              y: ofDecimal(spot.y),
              width: ofDecimal(spot.width),
              height: ofDecimal(spot.height),
            }
          : null,
      };
    });
  }

  private async lock(tx: TenantTxClient, id: string): Promise<FloorPlan> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM floor_plans WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw floorPlanNotFound();
    return tx.floorPlan.findUniqueOrThrow({ where: { id } });
  }

  private async summaries(
    tx: TenantTxClient,
    buildingId?: string,
    id?: string,
  ): Promise<FloorPlanSummary[]> {
    const plans = await tx.floorPlan.findMany({
      where: {
        ...(buildingId ? { buildingId } : {}),
        ...(id ? { id } : {}),
      },
      orderBy: [{ buildingId: 'asc' }, { floor: 'asc' }],
    });
    if (!plans.length) return [];
    const names = new Map(
      (
        await tx.building.findMany({
          where: { id: { in: [...new Set(plans.map((p) => p.buildingId))] } },
          select: { id: true, name: true },
        })
      ).map((b) => [b.id, b.name]),
    );
    const counts = new Map(
      (
        await tx.floorPlanUnit.groupBy({
          by: ['planId'],
          where: { planId: { in: plans.map((p) => p.id) } },
          _count: { _all: true },
        })
      ).map((c) => [c.planId, c._count._all]),
    );
    return plans
      .map((p) => ({
        id: p.id,
        buildingId: p.buildingId,
        buildingName: names.get(p.buildingId)!,
        floor: p.floor,
        hotspots: counts.get(p.id) ?? 0,
        updatedAt: p.updatedAt,
      }))
      .sort(
        (a, b) =>
          a.buildingName.localeCompare(b.buildingName) || a.floor - b.floor,
      );
  }

  private async readIn(tx: TenantTxClient, id: string): Promise<FloorPlanRead> {
    const [summary] = await this.summaries(tx, undefined, id);
    if (!summary) throw floorPlanNotFound();
    const plan = await tx.floorPlan.findUniqueOrThrow({ where: { id } });
    const spots = await tx.floorPlanUnit.findMany({ where: { planId: id } });
    const unitRows = new Map(
      (
        await tx.unit.findMany({
          where: { id: { in: spots.map((s) => s.unitId) } },
          select: { id: true, code: true, buildingId: true, floor: true },
        })
      ).map((u) => [u.id, u]),
    );
    return {
      ...summary,
      image: await this.files.readUrl(tx, plan.fileId),
      units: spots
        .map((s) => {
          const u = unitRows.get(s.unitId)!;
          return {
            unitId: s.unitId,
            unitCode: u.code,
            x: ofDecimal(s.x),
            y: ofDecimal(s.y),
            width: ofDecimal(s.width),
            height: ofDecimal(s.height),
            misplaced:
              u.buildingId !== plan.buildingId || u.floor !== plan.floor,
          };
        })
        .sort((a, b) => a.unitCode.localeCompare(b.unitCode)),
    };
  }
}
