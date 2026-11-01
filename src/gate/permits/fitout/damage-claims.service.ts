import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type PermitDamageClaim,
  type UnitPermit,
} from '@prisma/client';
import { AccountLifecycle } from '../../../core/accounts/account-lifecycle';
import { AuditService } from '../../../core/audit/audit.service';
import { StepUpService } from '../../../core/auth/step-up.service';
import { Charges } from '../../../core/charges/charges';
import { RequestContext } from '../../../core/common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../../core/common/errors';
import {
  REASON_CODES,
  requireReasonCodeOnly,
} from '../../../core/common/reasons';
import { addDays, localDate } from '../../../core/common/slots/day-slots';
import { newId } from '../../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../../core/database/tenant-tx.service';
import { FilesService } from '../../../core/files/files.service';
import { WorksDeposits } from '../../../core/works/works-deposits';
import { dbNow } from '../../db-clock';
import { PermitCore } from '../permit-core';
import { clean } from '../permits.service';
import { FitOutAccess } from './fitout-access';

/** The household appeals a claim this long after it is raised (ADR 0074). */
export const CLAIM_APPEAL_DAYS = 14;
/** A remainder owed as a charge is due this many local days on. */
export const CLAIM_DUE_DAYS = 14;
export const CLAIM_TEXT = { min: 1, max: 1000 } as const;
export const CLAIM_PHOTOS = { min: 1, max: 6 } as const;
/** EGP, two decimals, more than zero and at most a million. */
export const CLAIM_AMOUNT = /^(?!0+(\.0{1,2})?$)\d{1,7}(\.\d{1,2})?$/;
export const CLAIM_MAX_AMOUNT = 1_000_000;
const DAY_MS = 86_400_000;

export const damageClaimNumber = (n: number) =>
  `DC-${String(n).padStart(4, '0')}`;

const claimNotFound = () =>
  appError.notFound(ErrorCode.DAMAGE_CLAIM_NOT_FOUND, 'Damage claim not found');

export interface NewDamageClaim {
  reasonCode: string;
  description: string;
  amount: string;
  commonAreaId?: string;
  photoFileIds: string[];
}

/**
 * Damage claims on a works permit (ADR 0074). The management
 * (`permits.manage`) raises one on an approved (or revoked) works permit —
 * a code, words the household reads, an amount, an optional common area,
 * one to six `fitout_photo` files — and the requester and the unit's
 * primary are told. Either appeals it once within 14 days; the management
 * upholds the claim (open again) or accepts the appeal (withdrawn). The
 * management withdraws an open claim with a code. An open claim whose
 * appeal was decided, or whose window passed, is settled once, with a
 * fresh step-up: taken from the works deposit named on the permit as far
 * as it holds (finance's `damage` deduction), the rest owed as a `damage`
 * invoice of the unit's through the charges port (ADR 0070).
 *
 * Lock order: the fit-out's (the account, the unit, the permit's row),
 * then the unit's finance lock (Charges.lockUnit: a deposit's refund takes
 * it too, so it waits for a claim being raised or settled), the claim's
 * row, the deposit's row (finance's), the files, and last the number.
 */
@Injectable()
export class DamageClaimsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly access: FitOutAccess,
    private readonly core: PermitCore,
    private readonly charges: Charges,
    private readonly deposits: WorksDeposits,
    private readonly stepUp: StepUpService,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    // The appellant's words and photo go with them (ADR 0036).
    this.lifecycle.onErasing(async (tx, account) => {
      await this.forget(tx, account.id);
      return [];
    });
  }

  // --------------------------------------------------------------------------
  // The management
  // --------------------------------------------------------------------------

  raise(permitId: string, input: NewDamageClaim): Promise<string> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.damageClaim,
    );
    const description = clean(input.description);
    const fields: FieldError[] = [];
    if (!description || description.length > CLAIM_TEXT.max)
      fields.push({
        field: 'description',
        code: FieldErrorCode.INVALID_LENGTH,
        params: { ...CLAIM_TEXT },
      });
    if (
      !CLAIM_AMOUNT.test(input.amount) ||
      Number(input.amount) > CLAIM_MAX_AMOUNT
    )
      fields.push({
        field: 'amount',
        code: FieldErrorCode.INVALID_VALUE,
        params: { max: CLAIM_MAX_AMOUNT },
      });
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      const p = await this.access.write(tx, permitId, 'staff', false);
      if (p.status !== 'approved' && p.status !== 'revoked')
        throw appError.conflict(
          ErrorCode.PERMIT_NOT_ACTIVE,
          'Only an approved works permit is claimed against',
          { params: { status: p.status } },
        );
      await this.charges.lockUnit(tx, p.unitId);
      if (
        input.commonAreaId !== undefined &&
        !(await tx.commonArea.count({
          where: { id: input.commonAreaId, active: true },
        }))
      )
        throw invalid([
          { field: 'commonAreaId', code: FieldErrorCode.INVALID_VALUE },
        ]);
      const now = await dbNow(tx);
      const id = newId();
      const photos: string[] = [];
      for (const fileId of [...new Set(input.photoFileIds)]) {
        const file = await this.files.claim(tx, fileId, 'fitout_photo');
        if (!file)
          throw appError.notFound(ErrorCode.FILE_NOT_FOUND, 'File not found');
        await this.files.attach(tx, file);
        photos.push(fileId);
      }
      const number = await this.nextNumber(tx);
      await tx.permitDamageClaim.create({
        data: {
          id,
          tenantId: p.tenantId,
          number,
          permitId: p.id,
          unitId: p.unitId,
          commonAreaId: input.commonAreaId ?? null,
          reasonCode: reason,
          description,
          amount: new Prisma.Decimal(input.amount),
          raisedBy: this.ctx.accountId,
          raisedAt: now,
          appealUntil: new Date(now.getTime() + CLAIM_APPEAL_DAYS * DAY_MS),
        },
      });
      for (const fileId of photos)
        await tx.permitDamageClaimPhoto.create({
          data: {
            id: newId(),
            tenantId: p.tenantId,
            claimId: id,
            fileId,
            createdAt: now,
          },
        });
      await this.audit.record(tx, {
        action: 'damage_claim.raised',
        targetId: id,
        metadata: {
          permitId: p.id,
          unitId: p.unitId,
          number: damageClaimNumber(number),
          reasonCode: reason,
          amount: new Prisma.Decimal(input.amount).toFixed(2),
          photos: photos.length,
        },
      });
      await this.core.notify(
        tx,
        await this.access.household(tx, p),
        'unit_permit.damage_claimed',
        p.id,
        { claimNumber: damageClaimNumber(number) },
      );
      return id;
    });
  }

  /** The appeal decided: the claim stands (`upheld`) or goes (`accepted`). */
  decideAppeal(
    permitId: string,
    claimId: string,
    decision: 'upheld' | 'accepted',
  ): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { p, claim } = await this.lock(tx, permitId, claimId, 'staff');
      if (claim.status !== 'under_appeal')
        throw notOpen(claim, 'The claim is not under appeal');
      const now = await dbNow(tx);
      await tx.permitDamageClaim.update({
        where: { id: claim.id },
        data: {
          appealDecision: decision,
          appealDecidedAt: now,
          appealDecidedBy: this.ctx.accountId,
          ...(decision === 'upheld'
            ? { status: 'open' }
            : {
                status: 'withdrawn',
                withdrawnAt: now,
                withdrawnBy: this.ctx.accountId,
                withdrawReason: 'appeal_accepted',
              }),
        },
      });
      await this.audit.record(tx, {
        action: 'damage_claim.appeal_decided',
        targetId: claim.id,
        metadata: { permitId: p.id, decision },
      });
      await this.core.notify(
        tx,
        [claim.appealedBy],
        'unit_permit.damage_appeal_decided',
        p.id,
        { claimNumber: damageClaimNumber(claim.number), decision },
      );
    });
  }

  /** An open claim (not under appeal) withdrawn, with a code. */
  withdraw(
    permitId: string,
    claimId: string,
    input: { reasonCode?: string },
  ): Promise<void> {
    const reason = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.damageClaimWithdraw.filter((c) => c !== 'appeal_accepted'),
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const { p, claim } = await this.lock(tx, permitId, claimId, 'staff');
      if (claim.status !== 'open')
        throw notOpen(
          claim,
          'Only an open claim not under appeal is withdrawn',
        );
      await tx.permitDamageClaim.update({
        where: { id: claim.id },
        data: {
          status: 'withdrawn',
          withdrawnAt: await dbNow(tx),
          withdrawnBy: this.ctx.accountId,
          withdrawReason: reason,
        },
      });
      await this.audit.record(tx, {
        action: 'damage_claim.withdrawn',
        targetId: claim.id,
        metadata: { permitId: p.id, reasonCode: reason },
      });
      await this.core.notify(
        tx,
        await this.access.household(tx, p),
        'unit_permit.damage_withdrawn',
        p.id,
        { claimNumber: damageClaimNumber(claim.number), reason },
      );
    });
  }

  /**
   * Settled once, with a fresh step-up: once its appeal was decided or its
   * window passed. From the works deposit as far as it holds, the rest as a
   * `damage` charge of the unit's, due in 14 local days.
   */
  settle(permitId: string, claimId: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const { p, claim } = await this.lock(tx, permitId, claimId, 'staff');
      await this.stepUp.consume(tx);
      if (claim.status !== 'open')
        throw notOpen(claim, 'Only an open claim not under appeal is settled');
      const now = await dbNow(tx);
      if (!claim.appealDecidedAt && claim.appealUntil.getTime() > now.getTime())
        throw appError.conflict(
          ErrorCode.DAMAGE_CLAIM_APPEAL_WINDOW,
          'The unit may still appeal',
          { params: { appealUntil: claim.appealUntil.toISOString() } },
        );
      const amount = new Prisma.Decimal(claim.amount);
      const deducted = await this.deposits.deductForClaim(tx, {
        permitId: p.id,
        amount,
        claimId: claim.id,
      });
      const charged = amount.sub(deducted);
      let invoiceId: string | null = null;
      if (charged.gt(0)) {
        const zone = await this.core.timeZone(tx);
        const number = damageClaimNumber(claim.number);
        const charge = await this.charges.raise(tx, {
          unitId: p.unitId,
          source: 'damage_claim',
          sourceId: claim.id,
          kind: 'damage',
          amount: charged,
          textEn: `Works damage claim ${number}`,
          textAr: `مطالبة أضرار أعمال ${number}`,
          dueOn: addDays(localDate(now, zone), CLAIM_DUE_DAYS),
        });
        invoiceId = charge.invoiceId;
      }
      await tx.permitDamageClaim.update({
        where: { id: claim.id },
        data: {
          status: 'settled',
          settledAt: now,
          settledBy: this.ctx.accountId,
          deducted,
          charged,
        },
      });
      await this.audit.record(tx, {
        action: 'damage_claim.settled',
        targetId: claim.id,
        metadata: {
          permitId: p.id,
          deducted: deducted.toFixed(2),
          charged: charged.toFixed(2),
          invoiceId,
        },
      });
      await this.core.notify(
        tx,
        await this.access.household(tx, p),
        'unit_permit.damage_settled',
        p.id,
        { claimNumber: damageClaimNumber(claim.number) },
      );
    });
  }

  // --------------------------------------------------------------------------
  // The household
  // --------------------------------------------------------------------------

  /** Appealed once, within its window, by the requester or the unit's primary. */
  appeal(
    permitId: string,
    claimId: string,
    input: { text: string; photoFileId?: string },
  ): Promise<void> {
    const text = clean(input.text);
    if (!text || text.length > CLAIM_TEXT.max)
      throw invalid([
        {
          field: 'text',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { ...CLAIM_TEXT },
        },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      const { p, claim } = await this.lock(tx, permitId, claimId, 'resident');
      const now = await dbNow(tx);
      if (
        claim.status !== 'open' ||
        claim.appealedAt ||
        claim.appealUntil.getTime() <= now.getTime()
      )
        throw appError.conflict(
          ErrorCode.DAMAGE_CLAIM_NO_APPEAL,
          'The claim takes no appeal now',
          {
            params: {
              status: claim.status,
              appealed: claim.appealedAt !== null,
              appealUntil: claim.appealUntil.toISOString(),
            },
          },
        );
      let photo: string | null = null;
      if (input.photoFileId) {
        const file = await this.files.claim(
          tx,
          input.photoFileId,
          'damage_appeal_photo',
        );
        if (!file)
          throw appError.notFound(ErrorCode.FILE_NOT_FOUND, 'File not found');
        await this.files.attach(tx, file);
        photo = file.id;
      }
      await tx.permitDamageClaim.update({
        where: { id: claim.id },
        data: {
          status: 'under_appeal',
          appealText: text,
          appealPhotoFileId: photo,
          appealedBy: this.ctx.accountId,
          appealedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'damage_claim.appealed',
        targetId: claim.id,
        metadata: { permitId: p.id, photo: photo !== null },
      });
      await this.core.notify(
        tx,
        await this.core.holding(tx, 'permits.manage'),
        'unit_permit.damage_appealed',
        p.id,
        { claimNumber: damageClaimNumber(claim.number) },
      );
    });
  }

  // --------------------------------------------------------------------------

  /** A permit's claims, newest first, with their photos. */
  async of(
    tx: TenantTxClient,
    permitId: string,
  ): Promise<{ claim: PermitDamageClaim; photoFileIds: string[] }[]> {
    const claims = await tx.permitDamageClaim.findMany({
      where: { permitId },
      orderBy: [{ raisedAt: 'desc' }, { id: 'desc' }],
    });
    const photos = claims.length
      ? await tx.permitDamageClaimPhoto.findMany({
          where: { claimId: { in: claims.map((c) => c.id) } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [];
    return claims.map((claim) => ({
      claim,
      photoFileIds: photos
        .filter((ph) => ph.claimId === claim.id)
        .map((ph) => ph.fileId),
    }));
  }

  /** How many of the permit's claims are still open or under appeal. */
  open(tx: TenantTxClient, permitId: string): Promise<number> {
    return tx.permitDamageClaim.count({
      where: { permitId, status: { in: ['open', 'under_appeal'] } },
    });
  }

  /**
   * The fit-out's lock order, then the unit's finance lock, then the
   * claim's row: one of the permit's, or the one not-found.
   */
  private async lock(
    tx: TenantTxClient,
    permitId: string,
    claimId: string,
    side: 'staff' | 'resident',
  ): Promise<{ p: UnitPermit; claim: PermitDamageClaim }> {
    const p = await this.access.write(tx, permitId, side, false);
    await this.charges.lockUnit(tx, p.unitId);
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM permit_damage_claims
       WHERE id = ${claimId}::uuid AND permit_id = ${p.id}::uuid FOR UPDATE`;
    if (!rows.length) throw claimNotFound();
    return {
      p,
      claim: await tx.permitDamageClaim.findUniqueOrThrow({
        where: { id: claimId },
      }),
    };
  }

  /** The compound's next claim number, under its advisory lock: take it last. */
  private async nextNumber(tx: TenantTxClient): Promise<number> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(
      hashtext(${`damage-claim:${this.ctx.txTenantId}`}), 0)`;
    const last = await tx.permitDamageClaim.findFirst({
      orderBy: { number: 'desc' },
      select: { number: true },
    });
    return (last?.number ?? 0) + 1;
  }

  /** The erased appellant's words and photo, once. */
  private async forget(tx: TenantTxClient, accountId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM permit_damage_claims
       WHERE appealed_by = ${accountId}::uuid
         AND appeal_text_cleared_at IS NULL
       ORDER BY id FOR UPDATE`;
    if (!rows.length) return;
    const now = await dbNow(tx);
    for (const { id } of rows) {
      const before = await tx.permitDamageClaim.findUniqueOrThrow({
        where: { id },
      });
      await tx.permitDamageClaim.update({
        where: { id },
        data: {
          appealText: null,
          appealPhotoFileId: null,
          appealTextClearedAt: now,
        },
      });
      if (before.appealPhotoFileId)
        await this.files.markDeleted(
          tx,
          { id: before.appealPhotoFileId, purpose: 'damage_appeal_photo' },
          'erasure',
        );
      await this.audit.record(tx, {
        action: 'damage_claim.appeal_cleared',
        targetId: id,
        metadata: {
          permitId: before.permitId,
          photo: before.appealPhotoFileId !== null,
        },
      });
    }
  }
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid damage claim', {
    fields,
  });

const notOpen = (claim: PermitDamageClaim, message: string) =>
  appError.conflict(ErrorCode.DAMAGE_CLAIM_NOT_OPEN, message, {
    params: { status: claim.status },
  });
