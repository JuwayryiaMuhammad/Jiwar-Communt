import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  Parcel,
  ParcelCarrier,
  ParcelCredential,
  ParcelMethod,
  ParcelStatus,
} from '@prisma/client';
import { CommunityGatePort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import {
  ParcelCore,
  parcelNotFound,
  stateConflict,
  type CredentialEnd,
} from './parcel-core';
import { ParcelTokens } from './parcel-tokens';

const PAGE = keysetCursor('receivedAt');

/** The idempotency resources of the residents' writes (ADR 0035). */
export const RESIDENT_PARCEL_RESOURCE = 'parcel_resident';
export const PARCEL_DELEGATE_RESOURCE = 'parcel_delegate';

export const DELEGATE_NAME = { min: 1, max: 80 } as const;

/** A delegate as the unit's residents see it. */
export interface ParcelDelegate {
  name: string;
  authorizedAt: Date;
  /** While the delegate may still collect: the code to share, and the QR. */
  code: string | null;
  qrPayload: string | null;
}

/**
 * A parcel as an eligible occupant of its unit sees it (ADR 0035): the
 * label's name, both photos, the delegate's name, and, while it is held,
 * the code and the QR to collect it with. Every response carrying this is
 * no-store.
 */
export interface ResidentParcel {
  id: string;
  number: number;
  unitCode: string;
  carrier: ParcelCarrier;
  pieces: number;
  status: ParcelStatus;
  receivedAt: Date;
  handedOverAt: Date | null;
  handedOverMethod: ParcelMethod | null;
  rejectedAt: Date | null;
  rejectReason: string | null;
  returnedAt: Date | null;
  labelName: string | null;
  photo: PresignedRead | null;
  handoverPhoto: PresignedRead | null;
  pickup: { code: string; qrPayload: string } | null;
  delegate: ParcelDelegate | null;
}

export interface ResidentParcelFilters {
  status?: ParcelStatus;
  cursor?: string;
  limit?: number;
}

/**
 * The residents' side of the parcels (ADR 0035). What decides is the
 * capability `parcels` on the parcel's unit, read under the parcel's lock:
 * a caller who is not eligible gets PARCEL_NOT_FOUND, never a 403.
 *
 * Lock order (ADR 0034): the caller's own account row (shared), then the
 * parcel. The lifecycle hooks below run under the exclusive account lock of
 * whoever caused them, and take the parcels after it.
 */
@Injectable()
export class ResidentParcels implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly notifier: Notifier,
    private readonly lifecycle: AccountLifecycle,
    private readonly community: CommunityGatePort,
    private readonly tokens: ParcelTokens,
    private readonly core: ParcelCore,
  ) {}

  onModuleInit(): void {
    // Replays are rendered for the caller, derived again: nothing is stored.
    this.idempotency.renderer(RESIDENT_PARCEL_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.view(tx, await this.readable(tx, id)),
      ),
    );
    this.idempotency.renderer(PARCEL_DELEGATE_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const credential = await tx.parcelCredential.findUnique({
          where: { id },
        });
        if (!credential) throw parcelNotFound();
        return this.view(tx, await this.readable(tx, credential.parcelId));
      }),
    );

    // A delegate does not outlive its authorizer: when the account that
    // authorized one stops holding `parcels` on the unit, it ends with them.
    this.lifecycle.onDeactivated(async (tx, account) => {
      await this.endDelegatesOf(tx, account.id, false);
      return [];
    });
    this.lifecycle.onFrozen((tx, account) =>
      this.endDelegatesOf(tx, account.id, false),
    );
    this.lifecycle.onErasing(async (tx, account) => {
      await this.endDelegatesOf(tx, account.id, false);
      return [];
    });
    this.lifecycle.onResidenceChanged((tx, account) =>
      this.endDelegatesOf(tx, account.id, true),
    );
  }

  /** The caller's parcels, newest first: every unit where they are eligible. */
  async list(f: ResidentParcelFilters): Promise<Page<ResidentParcel>> {
    const accountId = this.ctx.accountId;
    const limit = clampLimit(f.limit);
    return this.tenantTx.withTenantTx(async (tx) => {
      const units = await this.community.unitsWhere(tx, accountId, 'parcels');
      if (!units.length) return { items: [], nextCursor: null };
      const rows = await tx.parcel.findMany({
        where: {
          AND: [
            { unitId: { in: units }, status: f.status },
            ...(PAGE.after(f.cursor) as Prisma.ParcelWhereInput[]),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      const items: ResidentParcel[] = [];
      for (const parcel of page.items) items.push(await this.view(tx, parcel));
      return { items, nextCursor: page.nextCursor };
    });
  }

  get(id: string): Promise<ResidentParcel> {
    return this.tenantTx.withTenantTx(async (tx) =>
      this.view(tx, await this.readable(tx, id)),
    );
  }

  /**
   * "Not mine" (ADR 0035): `held` → `rejected`, with a reason code. Every
   * credential ends with it; the guards are told. `Idempotency-Key`.
   */
  async reject(
    id: string,
    reasonCode: string | undefined,
  ): Promise<ResidentParcel> {
    const reason = requireReasonCodeOnly(reasonCode, REASON_CODES.parcelReject);
    const accountId = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.idempotency.claim(tx, { type: RESIDENT_PARCEL_RESOURCE, id });
      const parcel = await this.lockedForResident(tx, id);
      if (parcel.status !== 'held') throw stateConflict(parcel.status);
      const rejected = await tx.parcel.update({
        where: { id },
        data: {
          status: 'rejected',
          rejectedAt: new Date(),
          rejectReason: reason,
        },
      });
      await this.core.endCredentials(tx, id, 'rejected');
      await this.core.event(tx, {
        parcelId: id,
        kind: 'rejected',
        side: 'resident',
        actorId: accountId,
        reasonCode: reason,
      });
      await this.audit.record(tx, {
        action: 'parcel.rejected',
        targetId: id,
        metadata: { reasonCode: reason },
      });
      await this.tellGuards(tx, rejected);
      return this.view(tx, rejected);
    });
  }

  /**
   * One delegate per parcel: a name (no phone) and a code of their own,
   * which the resident shares. `Idempotency-Key`: a retry derives the same
   * code again.
   */
  async authorizeDelegate(
    id: string,
    input: { name: string },
  ): Promise<ResidentParcel> {
    const name = input.name.trim();
    if (name.length < DELEGATE_NAME.min || name.length > DELEGATE_NAME.max)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid delegate name',
        {
          fields: [
            {
              field: 'name',
              code: FieldErrorCode.INVALID_LENGTH,
              params: { ...DELEGATE_NAME },
            },
          ],
        },
      );
    const accountId = this.ctx.accountId;
    const tenantId = this.ctx.tenantId;
    const credentialId = newId();
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.idempotency.claim(tx, {
        type: PARCEL_DELEGATE_RESOURCE,
        id: credentialId,
      });
      const parcel = await this.lockedForResident(tx, id);
      if (parcel.status !== 'held') throw stateConflict(parcel.status);
      if (await this.core.delegateOf(tx, id))
        throw appError.conflict(
          ErrorCode.PARCEL_DELEGATE_EXISTS,
          'This parcel already has a delegate',
        );
      const secret = await this.tokens.allocate(
        tenantId,
        credentialId,
        async (codeHash) =>
          (await tx.parcelCredential.count({ where: { codeHash } })) > 0,
      );
      try {
        await tx.parcelCredential.create({
          data: {
            id: credentialId,
            tenantId,
            parcelId: id,
            kind: 'delegate',
            attempt: secret.attempt,
            codeHash: secret.codeHash,
            qrTokenHash: secret.qrTokenHash,
            delegateName: name,
            createdById: accountId,
          },
        });
      } catch (error) {
        // The partial unique index behind the check above.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        )
          throw appError.conflict(
            ErrorCode.PARCEL_DELEGATE_EXISTS,
            'This parcel already has a delegate',
          );
        throw error;
      }
      await this.core.event(tx, {
        parcelId: id,
        kind: 'delegate_authorized',
        side: 'resident',
        actorId: accountId,
      });
      await this.audit.record(tx, {
        action: 'parcel.delegate_authorized',
        targetId: id,
      });
      return this.view(tx, parcel);
    });
  }

  /** Revocable until hand-over; a parcel with no delegate is a no-op. */
  revokeDelegate(id: string): Promise<void> {
    const accountId = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const parcel = await this.lockedForResident(tx, id);
      if (parcel.status !== 'held') throw stateConflict(parcel.status);
      const delegate = await this.core.delegateOf(tx, id);
      if (!delegate) return;
      await this.endDelegate(tx, delegate, 'revoked', 'resident', accountId);
    });
  }

  /**
   * The delegates this account authorized end when it no longer holds
   * `parcels` on their unit. `everyone`: it holds nothing any more (a
   * deactivation, a freeze, an erasure); otherwise it is re-checked per unit
   * (a residence change). Runs under the account's exclusive lock, and takes
   * the parcels after it, in id order (ADR 0034).
   */
  private async endDelegatesOf(
    tx: TenantTxClient,
    accountId: string,
    recheck: boolean,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
    const live = await tx.parcelCredential.findMany({
      where: { kind: 'delegate', createdById: accountId, endedAt: null },
      select: { parcelId: true },
      orderBy: { parcelId: 'asc' },
    });
    if (!live.length) return;
    await this.core.lockMany(
      tx,
      live.map((c) => c.parcelId),
    );
    for (const { parcelId } of live) {
      // Read again under the lock: a hand-over or a revoke may have won.
      const delegate = await this.core.delegateOf(tx, parcelId);
      if (!delegate || delegate.createdById !== accountId) continue;
      const parcel = await tx.parcel.findUnique({ where: { id: parcelId } });
      if (!parcel || parcel.status !== 'held') continue;
      if (recheck && (await this.core.isEligible(tx, accountId, parcel.unitId)))
        continue;
      await this.endDelegate(tx, delegate, 'authorizer_left', 'system', null);
    }
  }

  private async endDelegate(
    tx: TenantTxClient,
    delegate: ParcelCredential,
    reason: Extract<CredentialEnd, 'revoked' | 'authorizer_left'>,
    side: 'resident' | 'system',
    actorId: string | null,
  ): Promise<void> {
    await tx.parcelCredential.update({
      where: { id: delegate.id },
      data: {
        codeHash: null,
        qrTokenHash: null,
        endedAt: new Date(),
        endReason: reason,
        delegateName: null,
      },
    });
    await this.core.event(tx, {
      parcelId: delegate.parcelId,
      kind: 'delegate_revoked',
      side,
      actorId,
      reasonCode: reason,
    });
    await this.audit.record(tx, {
      action: 'parcel.delegate_revoked',
      targetId: delegate.parcelId,
      metadata: { reasonCode: reason },
    });
  }

  /**
   * Locks the caller's account, then the parcel, and only then asks whether
   * the caller is eligible for its unit: an unknown parcel, another
   * compound's and one the caller may not see are one answer.
   */
  private async lockedForResident(
    tx: TenantTxClient,
    id: string,
  ): Promise<Parcel> {
    await this.core.lockSelf(tx);
    const parcel = await this.core.lockedOrThrow(tx, id);
    if (!(await this.core.isEligible(tx, this.ctx.accountId, parcel.unitId)))
      throw parcelNotFound();
    return parcel;
  }

  /** Reads one parcel for a caller who is eligible for its unit. */
  private async readable(tx: TenantTxClient, id: string): Promise<Parcel> {
    const parcel = await tx.parcel.findUnique({ where: { id } });
    if (
      !parcel ||
      !(await this.core.isEligible(tx, this.ctx.accountId, parcel.unitId))
    )
      throw parcelNotFound();
    return parcel;
  }

  /** The guards on shift at the parcel's gate; later ones on their start. */
  private async tellGuards(tx: TenantTxClient, parcel: Parcel): Promise<void> {
    const shifts = await tx.guardShift.findMany({
      where: { gateId: parcel.gateId, endedAt: null },
      select: { guardAccountId: true },
      orderBy: { guardAccountId: 'asc' },
    });
    await this.notifier.notify(
      tx,
      shifts.map((s) => s.guardAccountId),
      {
        kind: 'parcel.rejected',
        targetId: parcel.id,
        params: { parcelNumber: parcel.number, carrier: parcel.carrier },
      },
    );
  }

  private async view(
    tx: TenantTxClient,
    parcel: Parcel,
  ): Promise<ResidentParcel> {
    const credentials = await tx.parcelCredential.findMany({
      where: { parcelId: parcel.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const holder = credentials.find((c) => c.kind === 'holder') ?? null;
    // The live delegate, else the one who collected (its name is kept until
    // the retention sweep): a revoked one keeps nothing.
    const delegate =
      credentials
        .filter((c) => c.kind === 'delegate' && c.delegateName !== null)
        .pop() ?? null;
    const delegateSecret = delegate ? this.core.pickupOf(delegate) : null;
    return {
      id: parcel.id,
      number: parcel.number,
      unitCode: await this.core.unitCodeOf(tx, parcel.unitId),
      carrier: parcel.carrier,
      pieces: parcel.pieces,
      status: parcel.status,
      receivedAt: parcel.receivedAt,
      handedOverAt: parcel.handedOverAt,
      handedOverMethod: parcel.handedOverMethod,
      rejectedAt: parcel.rejectedAt,
      rejectReason: parcel.rejectReason,
      returnedAt: parcel.returnedAt,
      labelName: parcel.labelName,
      ...(await this.core.photos(tx, parcel)),
      pickup: parcel.status === 'held' ? this.core.pickupOf(holder) : null,
      delegate:
        delegate && delegate.delegateName
          ? {
              name: delegate.delegateName,
              authorizedAt: delegate.createdAt,
              code: delegateSecret?.code ?? null,
              qrPayload: delegateSecret?.qrPayload ?? null,
            }
          : null,
    };
  }
}
