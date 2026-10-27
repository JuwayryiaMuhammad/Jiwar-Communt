import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Asset, AssetEvent, AssetType, CommonArea } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { CommonAreasService } from '../locations/common-areas.service';
import { issueTag } from '../locations/tag-tokens';
import { CompoundCalendar } from '../schedules/compound-calendar';
import {
  dateColumn,
  ofDateColumnOrNull,
  type LocalDate,
} from '../schedules/local-dates';
import { TicketAccess } from '../tickets/ticket-access';
import { UNFINISHED } from '../tickets/ticket-rules';
import {
  ageYears,
  health,
  MAX_DEPTH,
  type AssetCondition,
  type AssetCriticality,
  type AssetStatus,
  type HealthBand,
} from './asset-rules';
import { AssetTypesService } from './asset-types.service';

export const ASSET_RESOURCE = 'asset';

/** The facts of an asset's card, as the manager enters them. */
export interface AssetFacts {
  nameAr: string;
  nameEn: string;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  commissionedOn?: LocalDate | null;
  purchaseValue?: string | null;
  replacementCost?: string | null;
  downtimeCostPerDay?: string | null;
  expectedLifeYears?: number | null;
  vendorName?: string | null;
  vendorPhone?: string | null;
  warrantyEndsOn?: LocalDate | null;
  criticality?: AssetCriticality;
  condition?: AssetCondition;
  servesBuildings?: string[];
}

export interface AssetInput extends AssetFacts {
  code: string;
  typeId: string;
  parentId?: string;
  unitId?: string;
  commonAreaId?: string;
}

export type AssetUpdate = Partial<AssetFacts>;

export interface AssetQuery {
  typeId?: string;
  status?: AssetStatus;
  unitId?: string;
  commonAreaId?: string;
  parentId?: string;
  criticality?: AssetCriticality;
  cursor?: string;
  limit?: number;
}

/** Where an asset is: a unit or a common area, with its labels. */
export interface AssetPlace {
  unitId: string | null;
  unitCode: string | null;
  commonArea: Pick<
    CommonArea,
    'id' | 'code' | 'nameAr' | 'nameEn' | 'building' | 'kind'
  > | null;
}

export interface AssetCard {
  asset: Asset;
  type: AssetType;
  place: AssetPlace;
  childCount: number;
  lifeYears: number | null;
  ageYears: number | null;
  health: { score: number; band: HealthBand } | null;
  today: LocalDate;
}

/** A row ready to insert: validated, its place and depth resolved. */
export interface ResolvedAsset extends AssetFacts {
  code: string;
  typeId: string;
  parentId: string | null;
  depth: number;
  unitId: string | null;
  commonAreaId: string | null;
}

const PAGE = keysetCursor('createdAt', 'desc');
const EVENTS = keysetCursor('occurredAt', 'desc');

export const assetNotFound = () =>
  appError.notFound(ErrorCode.ASSET_NOT_FOUND, 'Asset not found');
const assetRetired = () =>
  appError.conflict(ErrorCode.ASSET_RETIRED, 'This asset is retired');
const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid asset', { fields });

/**
 * The asset register (ADR 0064). Assets are in a unit or a common area,
 * under a parent four levels deep at most, and a child is always where its
 * parent is. Kept with `assets.manage`, read with `assets.read`.
 *
 * Lock order: the caller's account (shared), then the asset rows, parent
 * before child, and the place (shared) a new asset goes to. A child is
 * created under its parent's shared lock and a move takes the root and its
 * subtree for update, so a child never lands where its parent no longer
 * is. Retiring waits for the children to be retired first. Times are the
 * database's; days the compound's.
 */
@Injectable()
export class AssetsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly community: CommunityMaintenancePort,
    private readonly areas: CommonAreasService,
    private readonly types: AssetTypesService,
    private readonly calendar: CompoundCalendar,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(ASSET_RESOURCE, (id) => this.card(id));
  }

  list(q: AssetQuery): Promise<Page<Asset>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.asset.findMany({
        where: {
          AND: [
            q.typeId ? { typeId: q.typeId } : {},
            q.status ? { status: q.status } : {},
            q.unitId ? { unitId: q.unitId } : {},
            q.commonAreaId ? { commonAreaId: q.commonAreaId } : {},
            q.parentId ? { parentId: q.parentId } : {},
            q.criticality ? { criticality: q.criticality } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      return PAGE.toPage(rows, limit);
    });
  }

  card(id: string): Promise<AssetCard> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const asset = await tx.asset.findUnique({ where: { id } });
      if (!asset) throw assetNotFound();
      return this.cardOf(tx, asset);
    });
  }

  /** The card of an asset read in the caller's transaction. */
  async cardOf(tx: TenantTxClient, asset: Asset): Promise<AssetCard> {
    const type = await tx.assetType.findUniqueOrThrow({
      where: { id: asset.typeId },
    });
    const place = await this.placeOf(tx, asset);
    const childCount = await tx.asset.count({
      where: { parentId: asset.id, status: { not: 'retired' } },
    });
    const { today } = await this.calendar.now(tx);
    const signals = await this.signals(tx, asset.id);
    const lifeYears = asset.expectedLifeYears ?? type.expectedLifeYears;
    const age = ageYears(ofDateColumnOrNull(asset.commissionedOn), today);
    return {
      asset,
      type,
      place,
      childCount,
      lifeYears,
      ageYears: age,
      health: health({
        condition: asset.condition as AssetCondition,
        status: asset.status as AssetStatus,
        ageYears: age,
        lifeYears,
        ...signals,
      }),
      today,
    };
  }

  /** The asset's own history, newest first. */
  events(
    id: string,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<AssetEvent>> {
    const limit = clampLimit(q.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.find(tx, id);
      const rows = await tx.assetEvent.findMany({
        where: { AND: [{ assetId: id }, ...EVENTS.after(q.cursor)] },
        orderBy: EVENTS.orderBy,
        take: limit + 1,
      });
      return EVENTS.toPage(rows, limit);
    });
  }

  /**
   * Who an asset's failure reaches (ADR 0064): the buildings it serves and
   * the one it is in, and how many units and occupied units they hold.
   * Counts only, never anyone in them.
   */
  impact(id: string): Promise<{
    buildings: string[];
    units: number;
    occupiedUnits: number;
  }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const asset = await this.find(tx, id);
      const place = await this.placeOf(tx, asset);
      const buildings = new Set(asset.servesBuildings);
      if (place.commonArea?.building) buildings.add(place.commonArea.building);
      const reach = await this.community.buildingReach(tx, [...buildings]);
      if (asset.unitId !== null && buildings.size === 0) {
        const occupied = await this.community.unitOccupied(tx, asset.unitId);
        return { buildings: [], units: 1, occupiedUnits: occupied ? 1 : 0 };
      }
      return { buildings: [...buildings].sort(), ...reach };
    });
  }

  create(input: AssetInput): Promise<AssetCard> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: ASSET_RESOURCE, id });
      await this.access.lockSelf(tx);
      const resolved = await this.resolve(tx, input);
      const asset = await this.insert(tx, id, resolved, 'created');
      await this.audit.record(tx, {
        action: 'asset.created',
        targetId: id,
        changes: diffChanges(null, audited(asset), 'asset.created'),
      });
      return this.cardOf(tx, asset);
    });
  }

  /**
   * Checks a new asset and finds its place and depth, under the locks a
   * write needs: the parent shared (a child goes where it is, and the
   * parent cannot be retired or moved meanwhile), the area shared.
   */
  async resolve(tx: TenantTxClient, input: AssetInput): Promise<ResolvedAsset> {
    await this.types.requireActive(tx, input.typeId);
    const fields: FieldError[] = [];
    const placed =
      input.unitId !== undefined || input.commonAreaId !== undefined;
    if (input.unitId !== undefined && input.commonAreaId !== undefined)
      fields.push({
        field: 'commonAreaId',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if (input.parentId !== undefined && placed)
      fields.push({
        field: input.unitId !== undefined ? 'unitId' : 'commonAreaId',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
    if (input.parentId === undefined && !placed)
      fields.push({ field: 'unitId', code: FieldErrorCode.FIELD_REQUIRED });
    if (fields.length) throw invalid(fields);
    await this.requireBuildings(tx, input.servesBuildings ?? []);
    if (input.parentId !== undefined) {
      const parent = await this.lockShared(tx, input.parentId);
      if (!parent || parent.status === 'retired')
        throw invalid([
          { field: 'parentId', code: FieldErrorCode.PARENT_NOT_AVAILABLE },
        ]);
      if (parent.depth >= MAX_DEPTH)
        throw invalid([
          {
            field: 'parentId',
            code: FieldErrorCode.ASSET_TOO_DEEP,
            params: { max: MAX_DEPTH },
          },
        ]);
      // A child is where its parent is: an area the parent holds stays
      // shared-locked through the parent's lock (a move takes the parent).
      return {
        ...input,
        parentId: parent.id,
        depth: parent.depth + 1,
        unitId: parent.unitId,
        commonAreaId: parent.commonAreaId,
      };
    }
    if (input.unitId !== undefined) {
      if (!(await this.community.unit(tx, input.unitId)))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
    } else await this.areas.requireActive(tx, input.commonAreaId!);
    return {
      ...input,
      parentId: null,
      depth: 1,
      unitId: input.unitId ?? null,
      commonAreaId: input.commonAreaId ?? null,
    };
  }

  /** Inserts a resolved asset and its first event. */
  async insert(
    tx: TenantTxClient,
    id: string,
    r: ResolvedAsset,
    kind: 'created' | 'imported',
  ): Promise<Asset> {
    const asset = await tx.asset.create({
      data: {
        id,
        tenantId: this.ctx.tenantId,
        code: r.code,
        typeId: r.typeId,
        parentId: r.parentId,
        depth: r.depth,
        unitId: r.unitId,
        commonAreaId: r.commonAreaId,
        ...facts(r),
        nameAr: r.nameAr.trim(),
        nameEn: r.nameEn.trim(),
        createdById: this.ctx.accountId,
      },
    });
    await this.event(tx, id, kind, { to: asset.code });
    return asset;
  }

  /** The card's facts; never its code, type, parent or place. */
  update(id: string, input: AssetUpdate): Promise<AssetCard> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.lock(tx, id);
      if (before.status === 'retired') throw assetRetired();
      if (input.servesBuildings !== undefined)
        await this.requireBuildings(tx, input.servesBuildings);
      const asset = await tx.asset.update({
        where: { id },
        data: facts(input),
      });
      const changes = diffChanges(
        audited(before),
        audited(asset),
        'asset.updated',
      );
      const changed = Object.keys(changes).sort();
      if (!changed.length) return this.cardOf(tx, asset);
      await this.audit.record(tx, {
        action: 'asset.updated',
        targetId: id,
        changes,
      });
      if (before.condition !== asset.condition)
        await this.event(tx, id, 'condition_changed', {
          from: before.condition,
          to: asset.condition,
        });
      const others = changed.filter((f) => f !== 'condition');
      if (others.length)
        await this.event(tx, id, 'updated', { to: others.join(',') });
      return this.cardOf(tx, asset);
    });
  }

  /** In or out of service; out of service takes a reason code. */
  setStatus(
    id: string,
    input: { status: 'in_service' | 'out_of_service'; reasonCode?: string },
  ): Promise<AssetCard> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.lock(tx, id);
      if (before.status === 'retired') throw assetRetired();
      let reason: string | null = null;
      if (input.status === 'out_of_service')
        reason = requireReasonCodeOnly(
          input.reasonCode,
          REASON_CODES.assetOutOfService,
        );
      else if (input.reasonCode !== undefined)
        throw invalid([
          { field: 'reasonCode', code: FieldErrorCode.FIELD_NOT_ALLOWED },
        ]);
      if (before.status === input.status && before.statusReason === reason)
        throw invalid([
          { field: 'status', code: FieldErrorCode.SAME_AS_CURRENT },
        ]);
      const asset = await tx.asset.update({
        where: { id },
        data: { status: input.status, statusReason: reason },
      });
      await this.event(tx, id, 'status_changed', {
        from: before.status,
        to: asset.status,
        reason,
      });
      await this.audit.record(tx, {
        action: 'asset.status_changed',
        targetId: id,
        changes: { status: { from: before.status, to: asset.status } },
        metadata: { reasonCode: reason },
      });
      return this.cardOf(tx, asset);
    });
  }

  /**
   * Retired for good, with a reason code; its children first (409
   * ASSET_HAS_ACTIVE_CHILDREN). What else ends with it (its plans, ADR
   * 0064) ends in the same transaction, through `onRetired`.
   */
  retire(id: string, input: { reasonCode?: string }): Promise<AssetCard> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const reason = requireReasonCodeOnly(
        input.reasonCode,
        REASON_CODES.assetRetire,
      );
      await this.access.lockSelf(tx);
      const before = await this.lock(tx, id);
      if (before.status === 'retired') throw assetRetired();
      if (
        await tx.asset.count({
          where: { parentId: id, status: { not: 'retired' } },
        })
      )
        throw appError.conflict(
          ErrorCode.ASSET_HAS_ACTIVE_CHILDREN,
          'Retire its parts first',
        );
      const now = await dbNow(tx);
      const asset = await tx.asset.update({
        where: { id },
        data: { status: 'retired', statusReason: reason, retiredAt: now },
      });
      for (const hook of this.retiredHooks) await hook(tx, asset);
      await this.event(tx, id, 'retired', { from: before.status, reason });
      await this.audit.record(tx, {
        action: 'asset.retired',
        targetId: id,
        metadata: { reasonCode: reason },
      });
      return this.cardOf(tx, asset);
    });
  }

  private readonly retiredHooks: ((
    tx: TenantTxClient,
    asset: Asset,
  ) => Promise<void>)[] = [];

  /** What ends with a retired asset, in its transaction (its plans). */
  onRetired(hook: (tx: TenantTxClient, asset: Asset) => Promise<void>): void {
    this.retiredHooks.push(hook);
  }

  /**
   * A root asset to another unit or common area, with its whole subtree
   * (locked for update, root first, the rest by id). A part moves only
   * with its root: 409 ASSET_NOT_ROOT.
   */
  move(
    id: string,
    to: { unitId?: string; commonAreaId?: string },
  ): Promise<AssetCard> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if ((to.unitId === undefined) === (to.commonAreaId === undefined))
        throw invalid([
          {
            field: to.unitId === undefined ? 'unitId' : 'commonAreaId',
            code:
              to.unitId === undefined
                ? FieldErrorCode.FIELD_REQUIRED
                : FieldErrorCode.FIELD_NOT_ALLOWED,
          },
        ]);
      await this.access.lockSelf(tx);
      const root = await this.lock(tx, id);
      if (root.status === 'retired') throw assetRetired();
      if (root.parentId !== null)
        throw appError.conflict(
          ErrorCode.ASSET_NOT_ROOT,
          'A part moves with its root',
        );
      if (to.unitId !== undefined) {
        if (!(await this.community.unit(tx, to.unitId)))
          throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      } else await this.areas.requireActive(tx, to.commonAreaId!);
      const unitId = to.unitId ?? null;
      const commonAreaId = to.commonAreaId ?? null;
      if (root.unitId === unitId && root.commonAreaId === commonAreaId)
        throw invalid([
          {
            field: unitId ? 'unitId' : 'commonAreaId',
            code: FieldErrorCode.SAME_AS_CURRENT,
          },
        ]);
      const subtree = await tx.$queryRaw<{ id: string }[]>`
        WITH RECURSIVE tree AS (
          SELECT id FROM assets WHERE parent_id = ${id}::uuid
          UNION ALL
          SELECT a.id FROM assets a JOIN tree t ON a.parent_id = t.id
        )
        SELECT id FROM assets WHERE id IN (SELECT id FROM tree)
         ORDER BY id FOR UPDATE`;
      const from = placeCode(root);
      const ids = [id, ...subtree.map((r) => r.id)];
      await tx.asset.updateMany({
        where: { id: { in: ids } },
        data: { unitId, commonAreaId },
      });
      const toCode = unitId ? `unit:${unitId}` : `area:${commonAreaId}`;
      for (const assetId of ids)
        await this.event(tx, assetId, 'moved', { from, to: toCode });
      await this.audit.record(tx, {
        action: 'asset.moved',
        targetId: id,
        changes: {
          unitId: { from: root.unitId, to: unitId },
          commonAreaId: { from: root.commonAreaId, to: commonAreaId },
        },
        metadata: { parts: subtree.length },
      });
      return this.cardOf(
        tx,
        await tx.asset.findUniqueOrThrow({ where: { id } }),
      );
    });
  }

  /** A new tag, shown once; the previous one stops working (see areas). */
  issueTag(id: string): Promise<{ code: string; issuedAt: Date }> {
    const tenantId = this.ctx.tenantId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const asset = await this.lock(tx, id);
      if (asset.status === 'retired') throw assetRetired();
      const tag = issueTag('asset', tenantId, id);
      const now = await dbNow(tx);
      await tx.asset.update({
        where: { id },
        data: { tagHash: tag.tokenHash, tagIssuedAt: now },
      });
      await this.event(tx, id, 'tag_issued', {});
      await this.audit.record(tx, {
        action: 'asset.tag_issued',
        targetId: id,
        metadata: { replaced: asset.tagHash !== null },
      });
      return { code: tag.code, issuedAt: now };
    });
  }

  /** Where an asset is, with the labels a card shows. */
  async placeOf(
    tx: TenantTxClient,
    asset: Pick<Asset, 'unitId' | 'commonAreaId'>,
  ): Promise<AssetPlace> {
    if (asset.unitId !== null) {
      const unit = await this.community.unit(tx, asset.unitId);
      return {
        unitId: asset.unitId,
        unitCode: unit?.code ?? null,
        commonArea: null,
      };
    }
    const area = await tx.commonArea.findUniqueOrThrow({
      where: { id: asset.commonAreaId! },
      select: {
        id: true,
        code: true,
        nameAr: true,
        nameEn: true,
        building: true,
        kind: true,
      },
    });
    return { unitId: null, unitCode: null, commonArea: area };
  }

  /** An asset, or ASSET_NOT_FOUND. */
  async find(tx: TenantTxClient, id: string): Promise<Asset> {
    const asset = await tx.asset.findUnique({ where: { id } });
    if (!asset) throw assetNotFound();
    return asset;
  }

  /** The asset locked for update, or ASSET_NOT_FOUND. */
  async lock(tx: TenantTxClient, id: string): Promise<Asset> {
    await tx.$queryRaw`SELECT id FROM assets WHERE id = ${id}::uuid FOR UPDATE`;
    return this.find(tx, id);
  }

  /** The asset shared-locked (nothing may retire or move it), or null. */
  async lockShared(tx: TenantTxClient, id: string): Promise<Asset | null> {
    await tx.$queryRaw`SELECT id FROM assets WHERE id = ${id}::uuid FOR SHARE`;
    return tx.asset.findUnique({ where: { id } });
  }

  /**
   * An asset that may take new work (a plan, an inspection, a ticket),
   * shared-locked: ASSET_NOT_FOUND, or ASSET_RETIRED.
   */
  async requireActive(tx: TenantTxClient, id: string): Promise<Asset> {
    const asset = await this.lockShared(tx, id);
    if (!asset) throw assetNotFound();
    if (asset.status === 'retired') throw assetRetired();
    return asset;
  }

  /**
   * Appends to the asset's history, timed by the database. The actor is
   * the signed-in account, or nobody for the system's own work (a sweep:
   * then the compound is the asset's, passed in).
   */
  async event(
    tx: TenantTxClient,
    assetId: string,
    kind: AssetEvent['kind'],
    v: { from?: string | null; to?: string | null; reason?: string | null },
    tenantId: string = this.ctx.tenantId,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO asset_events
        (id, tenant_id, asset_id, kind, from_value, to_value, reason_code,
         actor_account_id, occurred_at)
      VALUES (${newId()}::uuid, ${tenantId}::uuid, ${assetId}::uuid,
              ${kind}, ${v.from ?? null}, ${v.to ?? null}, ${v.reason ?? null},
              ${this.ctx.accountIdOrNull()}::uuid,
              date_trunc('milliseconds', clock_timestamp()))`;
  }

  /**
   * What lowers an asset's health besides its own card (ADR 0064): its
   * open corrective tickets (any but a plan's) and its overdue planned work.
   */
  protected async signals(
    tx: TenantTxClient,
    assetId: string,
  ): Promise<{ openCorrective: number; overduePlanned: number }> {
    const openCorrective = await tx.ticket.count({
      where: {
        assetId,
        origin: { not: 'plan' },
        status: { in: [...UNFINISHED] },
      },
    });
    const [{ overdue }] = await tx.$queryRaw<{ overdue: bigint }[]>`
      SELECT count(*) AS overdue
        FROM maintenance_plan_occurrences o
        JOIN maintenance_plans p ON p.id = o.plan_id
        JOIN tenant_settings s ON s.tenant_id = p.tenant_id
       WHERE p.asset_id = ${assetId}::uuid AND o.status = 'open'
         AND o.due_on + p.grace_days
             < (clock_timestamp() AT TIME ZONE s.timezone)::date`;
    return { openCorrective, overduePlanned: Number(overdue) };
  }

  private async requireBuildings(
    tx: TenantTxClient,
    buildings: readonly string[],
  ) {
    const fields: FieldError[] = [];
    for (const [i, b] of buildings.entries())
      if (!(await this.community.hasBuilding(tx, b)))
        fields.push({
          field: `servesBuildings.${i}`,
          code: FieldErrorCode.BUILDING_NOT_FOUND,
        });
    if (fields.length) throw invalid(fields);
  }
}

/** The card's facts as columns: dates as DATEs, texts trimmed. */
function facts(f: Partial<AssetFacts>) {
  const text = (v: string | null | undefined) =>
    v === undefined ? undefined : v === null ? null : v.trim();
  const date = (v: LocalDate | null | undefined) =>
    v === undefined ? undefined : v === null ? null : dateColumn(v);
  return {
    nameAr: text(f.nameAr) ?? undefined,
    nameEn: text(f.nameEn) ?? undefined,
    manufacturer: text(f.manufacturer),
    model: text(f.model),
    serialNumber: text(f.serialNumber),
    commissionedOn: date(f.commissionedOn),
    purchaseValue: f.purchaseValue,
    replacementCost: f.replacementCost,
    downtimeCostPerDay: f.downtimeCostPerDay,
    expectedLifeYears: f.expectedLifeYears,
    vendorName: text(f.vendorName),
    vendorPhone: text(f.vendorPhone),
    warrantyEndsOn: date(f.warrantyEndsOn),
    criticality: f.criticality,
    condition: f.condition,
    servesBuildings:
      f.servesBuildings === undefined
        ? undefined
        : [...new Set(f.servesBuildings.map((b) => b.trim()))].sort(),
  };
}

const placeCode = (a: Pick<Asset, 'unitId' | 'commonAreaId'>) =>
  a.unitId ? `unit:${a.unitId}` : `area:${a.commonAreaId}`;

/**
 * What the audit trail keeps of an asset: codes, keys, dates and amounts.
 * The names, the vendor's name and phone and the serial number go as
 * `{ changed: true }` (the catalog marks them sensitive).
 */
export function audited(a: Asset) {
  return {
    code: a.code,
    typeId: a.typeId,
    parentId: a.parentId,
    unitId: a.unitId,
    commonAreaId: a.commonAreaId,
    nameAr: a.nameAr,
    nameEn: a.nameEn,
    manufacturer: a.manufacturer,
    model: a.model,
    serialNumber: a.serialNumber,
    commissionedOn: ofDateColumnOrNull(a.commissionedOn),
    purchaseValue: a.purchaseValue?.toFixed(2) ?? null,
    replacementCost: a.replacementCost?.toFixed(2) ?? null,
    downtimeCostPerDay: a.downtimeCostPerDay?.toFixed(2) ?? null,
    expectedLifeYears: a.expectedLifeYears,
    vendorName: a.vendorName,
    vendorPhone: a.vendorPhone,
    warrantyEndsOn: ofDateColumnOrNull(a.warrantyEndsOn),
    criticality: a.criticality,
    condition: a.condition,
    servesBuildings: a.servesBuildings.join(','),
  };
}
