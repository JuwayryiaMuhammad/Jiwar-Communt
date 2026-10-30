import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { FoundItem } from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { PlacesService } from '../places/places.service';
import { DutyNamesReader } from '../roster/duty-names';
import { ShiftsService, type DutyShift } from '../shifts/shifts.service';
import { SafetyCore } from '../safety/safety-core';
import {
  FoundItemView,
  StaffFoundItemView,
  type FoundItemContext,
} from './views/found-item.views';

export const FOUND_ITEM_RESOURCE = 'found_item';
/** The same item, as the guard who registered it at the gate is answered. */
export const GATE_FOUND_ITEM_RESOURCE = 'gate_found_item';

/** Who acts: a guard at the gate, or the management at the office. */
export type FoundItemSide = 'gate' | 'office';
export const FOUND_ITEM_RETENTION_SWEEP = 'gate.found_item_names';
/** A claimant's name is kept as long as a visitor's (ADR 0028). */
export const CLAIMANT_NAME_DAYS = 30;
export const MAX_FOUND_ITEM_PHOTOS = 3;
const TEXT = { description: 500, location: 120, name: 80, note: 500 };
const CURSOR = keysetCursor('createdAt');
const DAY_MS = 86_400_000;

const notFound = () =>
  appError.notFound(ErrorCode.FOUND_ITEM_NOT_FOUND, 'Found item not found');
const closed = (status: string) =>
  appError.conflict(ErrorCode.FOUND_ITEM_CLOSED, 'Not where this happens', {
    params: { status },
  });

type Status = FoundItem['status'];

/**
 * The gate's lost-and-found register (ADR 0050). A guard on shift
 * registers what was found or handed in — what, where, when, photos; their
 * shift and post are recorded — and records its owner's claim at the gate.
 * The management (`found_items.manage`) receives an item from the gate and
 * records claims at the office, and may register at the office too. A
 * claimant is a unit (its code) and/or a name as told; the name goes after
 * 30 days, as a visitor's (a sweep). Every write takes the item's row. The
 * residents' lost-and-found board stays the neighbours' (ADR 0042): the
 * management may post an item there with its own route.
 */
@Injectable()
export class FoundItemsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly files: FilesService,
    private readonly places: PlacesService,
    private readonly shifts: ShiftsService,
    private readonly safety: SafetyCore,
    private readonly community: CommunityGatePort,
    private readonly names: DutyNamesReader,
    private readonly sweep: SweepRunner,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(FOUND_ITEM_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.staffView(
          tx,
          await tx.foundItem.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
    this.idempotency.renderer(GATE_FOUND_ITEM_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.viewFor(
          tx,
          await tx.foundItem.findUniqueOrThrow({ where: { id } }),
          'gate',
        ),
      ),
    );
    this.sweep.register(FOUND_ITEM_RETENTION_SWEEP, (now) =>
      this.clearNamesDue(now),
    );
  }

  /**
   * At the gate (the caller's open shift, its post recorded) or at the
   * office. `Idempotency-Key`.
   */
  register(
    input: {
      description: string;
      placeId?: string;
      location?: string;
      foundAt?: Date;
      photoFileIds?: string[];
    },
    side: FoundItemSide,
  ): Promise<FoundItemView | StaffFoundItemView> {
    const atGate = side === 'gate';
    const description = input.description.trim();
    const location = input.location?.trim() || null;
    const photoIds = [...new Set(input.photoFileIds ?? [])];
    const fields: Parameters<typeof invalid>[0] = [];
    if (!description || description.length > TEXT.description)
      fields.push({
        field: 'description',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 1, max: TEXT.description },
      });
    if (location && location.length > TEXT.location)
      fields.push({
        field: 'location',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 1, max: TEXT.location },
      });
    if (photoIds.length > MAX_FOUND_ITEM_PHOTOS)
      fields.push({
        field: 'photoFileIds',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 0, max: MAX_FOUND_ITEM_PHOTOS },
      });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      // At the gate, the account, then the shift, FOR SHARE (ADR 0056's
      // lock order): the shift's end waits for the item, or came first and
      // it is refused. The place comes after the shift; a zone's
      // retirement takes the zone's shifts first too.
      let duty: DutyShift | null = null;
      if (atGate) {
        await this.safety.lockSelf(tx);
        duty = await this.shifts.requireOnDutyLocked(tx);
      }
      const placeId = await this.places.requireActive(
        tx,
        input.placeId,
        'placeId',
      );
      const now = await dbNow(tx);
      if (input.foundAt && input.foundAt > now)
        throw invalid([
          { field: 'foundAt', code: FieldErrorCode.INVALID_VALUE },
        ]);
      const id = newId();
      await this.idempotency.claim(tx, {
        type: atGate ? GATE_FOUND_ITEM_RESOURCE : FOUND_ITEM_RESOURCE,
        id,
      });
      const item = await tx.foundItem.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          description,
          placeId,
          location,
          foundAt: input.foundAt ?? now,
          registeredById: this.ctx.accountId,
          shiftId: duty?.id ?? null,
          gateId: duty?.gateId ?? null,
          zoneId: duty?.placeId ?? null,
          createdAt: now,
        },
      });
      for (const fileId of photoIds) {
        const file = await this.files.claim(tx, fileId, 'found_item_photo');
        if (!file)
          throw invalid([
            { field: 'photoFileIds', code: FieldErrorCode.FILE_NOT_AVAILABLE },
          ]);
        await this.files.attach(tx, file);
        await tx.foundItemPhoto.create({
          data: {
            id: newId(),
            tenantId: this.ctx.txTenantId,
            itemId: id,
            fileId,
            uploadedById: this.ctx.accountId,
          },
        });
      }
      await this.audit.record(tx, {
        action: 'found_item.registered',
        targetId: id,
        metadata: {
          shiftId: duty?.id ?? null,
          placeId,
          photos: photoIds.length,
        },
      });
      return this.viewFor(tx, item, side);
    });
  }

  /** The management receives an item held at the gate. */
  receive(id: string): Promise<StaffFoundItemView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const item = await this.lock(tx, id);
      if (!item) throw notFound();
      if (item.status !== 'at_gate') throw closed(item.status);
      const received = await tx.foundItem.update({
        where: { id },
        data: {
          status: 'with_management',
          receivedAt: await dbNow(tx),
          receivedById: this.ctx.accountId,
        },
      });
      await this.audit.record(tx, {
        action: 'found_item.received',
        targetId: id,
      });
      return this.staffView(tx, received);
    });
  }

  /**
   * Its owner claims it: at the gate while it is held there (`from`
   * `at_gate`), at the office while the management holds it, or either for
   * the management. A unit's code and/or a name as told, once.
   */
  claim(
    id: string,
    input: { unitCode?: string; name?: string; note?: string },
    side: FoundItemSide,
  ): Promise<FoundItemView | StaffFoundItemView> {
    const from: readonly Status[] =
      side === 'gate' ? ['at_gate'] : ['at_gate', 'with_management'];
    const unitCode = input.unitCode?.trim() || null;
    const name = input.name?.trim() || null;
    const note = input.note?.trim() || null;
    const fields: Parameters<typeof invalid>[0] = [];
    if (!unitCode && !name)
      fields.push({ field: 'name', code: FieldErrorCode.FIELD_REQUIRED });
    if (name && name.length > TEXT.name)
      fields.push({
        field: 'name',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 1, max: TEXT.name },
      });
    if (note && note.length > TEXT.note)
      fields.push({
        field: 'note',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { min: 1, max: TEXT.note },
      });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const item = await this.lock(tx, id);
      if (!item) throw notFound();
      if (!from.includes(item.status)) throw closed(item.status);
      const unit = unitCode
        ? await this.community.unitByCode(tx, unitCode)
        : null;
      if (unitCode && !unit)
        throw invalid([
          { field: 'unitCode', code: FieldErrorCode.UNIT_CODE_UNKNOWN },
        ]);
      const now = await dbNow(tx);
      const claimed = await tx.foundItem.update({
        where: { id },
        data: {
          status: 'claimed',
          claimedAt: now,
          claimRecordedById: this.ctx.accountId,
          claimantUnitId: unit?.id ?? null,
          claimantName: name,
          claimantNameExpiresAt: name
            ? new Date(now.getTime() + CLAIMANT_NAME_DAYS * DAY_MS)
            : null,
          claimNote: note,
        },
      });
      await this.audit.record(tx, {
        action: 'found_item.claimed',
        targetId: id,
        metadata: {
          unitId: unit?.id ?? null,
          name: name !== null,
          note: note !== null,
        },
      });
      return this.viewFor(tx, claimed, side);
    });
  }

  list(q: {
    status?: Status;
    cursor?: string;
    limit: number;
  }): Promise<Page<FoundItem>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.foundItem.findMany({
        where: {
          AND: [
            ...CURSOR.after(q.cursor),
            ...(q.status ? [{ status: q.status }] : []),
          ],
        },
        orderBy: CURSOR.orderBy,
        take: q.limit + 1,
      });
      return CURSOR.toPage(rows, q.limit);
    });
  }

  async staffList(q: {
    status?: Status;
    cursor?: string;
    limit: number;
  }): Promise<Page<StaffFoundItemView>> {
    const page = await this.list(q);
    return this.tenantTx.withTenantTx(async (tx) => ({
      items: await this.staffViews(tx, page.items),
      nextCursor: page.nextCursor,
    }));
  }

  async guardList(q: {
    status?: Status;
    cursor?: string;
    limit: number;
  }): Promise<Page<FoundItemView>> {
    const page = await this.list(q);
    return this.tenantTx.withTenantTx(async (tx) => ({
      items: await this.guardViews(tx, page.items),
      nextCursor: page.nextCursor,
    }));
  }

  get(id: string): Promise<StaffFoundItemView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const item = await tx.foundItem.findUnique({ where: { id } });
      if (!item) throw notFound();
      return this.staffView(tx, item);
    });
  }

  getForGuard(id: string): Promise<FoundItemView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const item = await tx.foundItem.findUnique({ where: { id } });
      if (!item) throw notFound();
      return (await this.guardViews(tx, [item]))[0];
    });
  }

  /**
   * Claimants' names past their 30 days, one compound at a time: cleared
   * once (the trigger allows it once), audited.
   */
  clearNamesDue(now: Date): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const due = await tx.foundItem.findMany({
        where: {
          claimantName: { not: null },
          claimantNameExpiresAt: { lte: now },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 500,
      });
      for (const { id } of due) {
        await tx.foundItem.update({
          where: { id },
          data: { claimantName: null, claimantNameClearedAt: now },
        });
        await this.audit.record(tx, {
          action: 'found_item.claimant_name_cleared',
          targetId: id,
        });
      }
      return due.length;
    });
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private async lock(
    tx: TenantTxClient,
    id: string,
  ): Promise<FoundItem | null> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM found_items WHERE id = ${id}::uuid FOR UPDATE`;
    if (!row) return null;
    return tx.foundItem.findUniqueOrThrow({ where: { id } });
  }

  private async context(
    tx: TenantTxClient,
    items: readonly FoundItem[],
  ): Promise<FoundItemContext> {
    const names = await this.names.read(
      tx,
      items.flatMap((i) => [
        i.registeredById,
        i.receivedById,
        i.claimRecordedById,
      ]),
      items.map((i) => ({ gateId: i.gateId, placeId: i.zoneId })),
    );
    const placeIds = [
      ...new Set(items.flatMap((i) => (i.placeId ? [i.placeId] : []))),
    ];
    const places = placeIds.length
      ? await tx.place.findMany({ where: { id: { in: placeIds } } })
      : [];
    const units = await this.community.unitLocations(
      tx,
      items.flatMap((i) => (i.claimantUnitId ? [i.claimantUnitId] : [])),
    );
    const photoRows = items.length
      ? await tx.foundItemPhoto.findMany({
          where: { itemId: { in: items.map((i) => i.id) } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [];
    const photos = new Map<string, { url: string; expiresAt: Date }[]>();
    for (const p of photoRows) {
      const url = await this.files.readUrl(tx, p.fileId);
      if (url) photos.set(p.itemId, [...(photos.get(p.itemId) ?? []), url]);
    }
    return {
      names,
      places: new Map(places.map((p) => [p.id, p])),
      units,
      photos,
    };
  }

  private viewFor(
    tx: TenantTxClient,
    item: FoundItem,
    side: FoundItemSide,
  ): Promise<FoundItemView | StaffFoundItemView> {
    return side === 'gate'
      ? this.guardViews(tx, [item]).then((v) => v[0])
      : this.staffView(tx, item);
  }

  private async staffViews(
    tx: TenantTxClient,
    items: readonly FoundItem[],
  ): Promise<StaffFoundItemView[]> {
    const c = await this.context(tx, items);
    return items.map((i) => StaffFoundItemView.of(i, c));
  }

  private async staffView(
    tx: TenantTxClient,
    item: FoundItem,
  ): Promise<StaffFoundItemView> {
    return (await this.staffViews(tx, [item]))[0];
  }

  private async guardViews(
    tx: TenantTxClient,
    items: readonly FoundItem[],
  ): Promise<FoundItemView[]> {
    const c = await this.context(tx, items);
    return items.map((i) => FoundItemView.from(i, c));
  }
}
