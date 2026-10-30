import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Inspection, ReadinessItem } from '@prisma/client';
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
import { dbNow } from '../db-clock';
import { InspectionsService } from '../inspections/inspections.service';
import { CompoundCalendar } from '../schedules/compound-calendar';
import { ofDateColumn } from '../schedules/local-dates';
import { TicketAccess } from '../tickets/ticket-access';
import { itemState } from './readiness-rules';
import { ReadinessService } from './readiness.service';

export interface CampaignInput {
  inspectorId: string;
  assetIds?: string[];
  commonAreaIds?: string[];
}

export interface CampaignInspection {
  inspectionId: string;
  assetId: string | null;
  commonAreaId: string | null;
  status: string;
}

export interface CampaignRead {
  item: ReadinessItem;
  inspections: CampaignInspection[];
  /** The inspections this call spawned (none when every target had one). */
  spawned: string[];
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid campaign', {
    fields,
  });

/**
 * A readiness program's inspection campaign (ADR 0067): its item names a
 * checklist; spawning it schedules one inspection per target — an asset
 * of the compound's or a common area — due on the item's day, given to an
 * inspector, through InspectionsService.createInTx. Each target is
 * inspected once per campaign (the unique keys of
 * readiness_campaign_inspections): spawning again adds only the targets it
 * does not hold. The item is done, by nobody, in the transaction that
 * submits or cancels its last open inspection; it is not called off while
 * one is open.
 *
 * Locks: the caller's account and the inspector's, then the program
 * (shared) and the item, then the targets (shared). The hook runs under
 * the inspection's lock, then takes the program (shared) and the item: an
 * inspection is never locked after an item.
 */
@Injectable()
export class CampaignsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly audit: AuditService,
    private readonly calendar: CompoundCalendar,
    private readonly inspections: InspectionsService,
    private readonly readiness: ReadinessService,
  ) {}

  onModuleInit(): void {
    this.inspections.onEnded((tx, inspection) =>
      this.afterInspection(tx, inspection),
    );
  }

  /** The campaign's inspections, with their status. */
  get(itemId: string): Promise<CampaignRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const item = await tx.readinessItem.findUnique({ where: { id: itemId } });
      if (!item)
        throw appError.notFound(
          ErrorCode.READINESS_ITEM_NOT_FOUND,
          'Readiness item not found',
        );
      requireCampaign(item);
      return {
        item,
        inspections: await this.spawnedOf(tx, itemId),
        spawned: [],
      };
    });
  }

  /** Schedules an inspection for each target the campaign does not hold yet. */
  spawn(itemId: string, input: CampaignInput): Promise<CampaignRead> {
    const assetIds = [...new Set(input.assetIds ?? [])].sort();
    const areaIds = [...new Set(input.commonAreaIds ?? [])].sort();
    if (!assetIds.length && !areaIds.length)
      throw invalid([
        { field: 'assetIds', code: FieldErrorCode.FIELD_REQUIRED },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await this.inspections.requireInspector(
        tx,
        input.inspectorId,
        'inspectorId',
      );
      const { program, item } = await this.readiness.lockItem(tx, itemId);
      requireCampaign(item);
      const state = itemState(item);
      if (state !== 'open')
        throw appError.conflict(
          ErrorCode.READINESS_ITEM_ENDED,
          'This readiness item has ended',
          { params: { state } },
        );
      const { today } = await this.calendar.now(tx);
      const dueOn = ofDateColumn(item.dueOn);
      if (dueOn < today)
        throw appError.conflict(
          ErrorCode.READINESS_ITEM_PAST_DUE,
          'The item’s day has passed: move it first',
          { params: { dueOn } },
        );
      await this.requireTargets(tx, input, assetIds, areaIds);
      const held = await tx.readinessCampaignInspection.findMany({
        where: { itemId },
        select: { assetId: true, commonAreaId: true },
      });
      const heldAssets = new Set(held.map((h) => h.assetId));
      const heldAreas = new Set(held.map((h) => h.commonAreaId));
      const targets = [
        ...assetIds
          .filter((id) => !heldAssets.has(id))
          .map((assetId) => ({ assetId })),
        ...areaIds
          .filter((id) => !heldAreas.has(id))
          .map((commonAreaId) => ({ commonAreaId })),
      ];
      const spawned: string[] = [];
      const now = await dbNow(tx);
      for (const target of targets) {
        const inspection = await this.inspections.createInTx(
          tx,
          newId(),
          {
            ...target,
            checklistId: item.checklistId!,
            assigneeId: input.inspectorId,
            dueOn,
          },
          item.id,
        );
        await tx.readinessCampaignInspection.create({
          data: {
            id: newId(),
            tenantId: item.tenantId,
            itemId: item.id,
            inspectionId: inspection.id,
            assetId: inspection.assetId,
            commonAreaId: inspection.commonAreaId,
            createdAt: now,
          },
        });
        spawned.push(inspection.id);
      }
      if (spawned.length)
        await this.audit.record(tx, {
          action: 'readiness_campaign.spawned',
          targetId: item.id,
          metadata: {
            programId: program.id,
            checklistId: item.checklistId,
            inspectorId: input.inspectorId,
            dueOn,
            inspectionIds: spawned,
          },
        });
      return { item, inspections: await this.spawnedOf(tx, itemId), spawned };
    });
  }

  /**
   * The hook, in the transaction that submitted or cancelled `inspection`,
   * under its lock: its campaign's item is done, by nobody, when no
   * inspection of it is open any more — while the item is open and its
   * program not closed.
   */
  private async afterInspection(
    tx: TenantTxClient,
    inspection: Inspection,
  ): Promise<void> {
    const link = await tx.readinessCampaignInspection.findFirst({
      where: { inspectionId: inspection.id },
      select: { itemId: true },
    });
    if (!link) return;
    const seen = await tx.readinessItem.findUniqueOrThrow({
      where: { id: link.itemId },
    });
    await tx.$queryRaw`SELECT id FROM readiness_programs WHERE id = ${seen.programId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM readiness_items WHERE id = ${seen.id}::uuid FOR UPDATE`;
    const [program, item] = [
      await tx.readinessProgram.findUniqueOrThrow({
        where: { id: seen.programId },
      }),
      await tx.readinessItem.findUniqueOrThrow({ where: { id: seen.id } }),
    ];
    if (program.closedAt !== null || itemState(item) !== 'open') return;
    if ((await this.readiness.openCampaignInspections(tx, item.id)) > 0) return;
    const inspections = await tx.readinessCampaignInspection.count({
      where: { itemId: item.id },
    });
    await tx.readinessItem.update({
      where: { id: item.id },
      data: { doneAt: await dbNow(tx), doneById: null },
    });
    await this.audit.record(tx, {
      action: 'readiness_item.done',
      targetId: item.id,
      metadata: {
        programId: program.id,
        kind: item.kind,
        by: 'inspections',
        inspections,
        lastInspectionId: inspection.id,
      },
    });
  }

  private async spawnedOf(
    tx: TenantTxClient,
    itemId: string,
  ): Promise<CampaignInspection[]> {
    const links = await tx.readinessCampaignInspection.findMany({
      where: { itemId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const statuses = await tx.inspection.findMany({
      where: { id: { in: links.map((l) => l.inspectionId) } },
      select: { id: true, status: true },
    });
    const of = new Map(statuses.map((s) => [s.id, s.status]));
    return links.map((l) => ({
      inspectionId: l.inspectionId,
      assetId: l.assetId,
      commonAreaId: l.commonAreaId,
      status: of.get(l.inspectionId)!,
    }));
  }

  /**
   * Every target active and the compound's to inspect (never an asset in a
   * unit), shared-locked in id order; a bad one is named by its place in
   * the list.
   */
  private async requireTargets(
    tx: TenantTxClient,
    input: CampaignInput,
    assetIds: string[],
    areaIds: string[],
  ): Promise<void> {
    const fields: FieldError[] = [];
    if (assetIds.length) {
      await tx.$queryRaw`SELECT id FROM assets WHERE id = ANY(${assetIds}::uuid[]) ORDER BY id FOR SHARE`;
      const ok = new Set(
        (
          await tx.asset.findMany({
            where: {
              id: { in: assetIds },
              status: { not: 'retired' },
              unitId: null,
            },
            select: { id: true },
          })
        ).map((a) => a.id),
      );
      (input.assetIds ?? []).forEach((id, i) => {
        if (!ok.has(id))
          fields.push({
            field: `assetIds.${i}`,
            code: FieldErrorCode.ASSET_NOT_AVAILABLE,
          });
      });
    }
    if (areaIds.length) {
      await tx.$queryRaw`SELECT id FROM common_areas WHERE id = ANY(${areaIds}::uuid[]) ORDER BY id FOR SHARE`;
      const ok = new Set(
        (
          await tx.commonArea.findMany({
            where: { id: { in: areaIds }, active: true },
            select: { id: true },
          })
        ).map((a) => a.id),
      );
      (input.commonAreaIds ?? []).forEach((id, i) => {
        if (!ok.has(id))
          fields.push({
            field: `commonAreaIds.${i}`,
            code: FieldErrorCode.COMMON_AREA_NOT_AVAILABLE,
          });
      });
    }
    if (fields.length) throw invalid(fields);
  }
}

function requireCampaign(item: ReadinessItem): void {
  if (item.kind !== 'inspection_campaign')
    throw appError.conflict(
      ErrorCode.READINESS_ITEM_NOT_A_CAMPAIGN,
      'This readiness item is not an inspection campaign',
      { params: { kind: item.kind } },
    );
}
