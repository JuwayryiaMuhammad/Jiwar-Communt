import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Parcel, ParcelCredential, ParcelMethod } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import type { Env } from '../../core/config/env.schema';
import {
  appError,
  AppException,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { parseEntryQr } from '../entry/entry-secrets';
import { ResidentVerifier } from '../entry/resident-verifier';
import { ShiftsService } from '../shifts/shifts.service';
import {
  ParcelCore,
  parcelNotFound,
  stateConflict,
  type GateParcel,
} from './parcel-core';
import { ParcelTokens } from './parcel-tokens';

/** The idempotency resource of a hand-over: re-rendered, never stored. */
export const PARCEL_HANDOVER_RESOURCE = 'parcel_handover';

/** Wrong presentations in a window that lock a guard out of codes (ADR 0035). */
export const PARCEL_FAILURE_LIMIT = 5;
export const PARCEL_LOCKOUT_SECONDS = 600;

/** What a code or QR is: the parcel, who presented, and a delegate's name. */
export interface ParcelLookup {
  result: 'valid' | 'invalid';
  parcel: GateParcel | null;
  presentedBy: 'holder' | 'delegate' | null;
  /** Only for a valid delegate's code, and only here and at the hand-over. */
  delegateName: string | null;
}

export interface ParcelHandedOver extends GateParcel {
  /** The delegate's name, when a delegate's code was the way. */
  delegateName: string | null;
}

export interface CodeInput {
  code?: string;
  qr?: string;
}

export interface HandOverInput extends CodeInput {
  /** A resident's rotating entry QR (`JWR2`, ADR 0031). */
  residentQr?: string;
  /** An optional photo of the hand-over (`parcel_photo`). */
  photoFileId?: string;
}

/** Unknown, malformed, dead and foreign are one answer (ADR 0030). */
const INVALID: ParcelLookup = {
  result: 'invalid',
  parcel: null,
  presentedBy: null,
  delegateName: null,
};

const codeInvalid = () =>
  appError.forbidden(
    ErrorCode.PARCEL_CODE_INVALID,
    'That code or QR does not open this parcel',
  );

const SIX_DIGITS = /^\d{6}$/;

/**
 * Exactly one of the named fields (the DTO cannot say it for three): none is
 * FIELD_REQUIRED on the first, a second is FIELD_NOT_ALLOWED on it.
 */
function exactlyOne(
  input: Record<string, unknown>,
  names: readonly string[],
): string {
  const sent = names.filter((n) => input[n] !== undefined);
  if (sent.length === 1) return sent[0];
  const fields: FieldError[] =
    sent.length === 0
      ? [{ field: names[0], code: FieldErrorCode.FIELD_REQUIRED }]
      : sent.slice(1).map((field) => ({
          field,
          code: FieldErrorCode.FIELD_NOT_ALLOWED,
        }));
  throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });
}

/**
 * The hand-over of a parcel (ADR 0035), by one of: the parcel's code or QR,
 * the entry QR of an eligible occupant of its unit, or a delegate's code.
 *
 * - **Throttled like ADR 0030, and locked out:** a budget per guard
 *   (`PARCEL_CODE_RATE_LIMIT_PER_MINUTE`), and five wrong presentations in
 *   ten minutes lock the guard out of codes until the window ends. The shift
 *   comes first, so a guard off duty learns nothing.
 * - **Enumeration-safe:** an unknown, malformed, dead or foreign code, the
 *   code of another parcel, and a resident QR that is not genuine or not an
 *   occupant of this unit's are one answer
 *   (`PARCEL_CODE_INVALID`), whatever part was wrong. Only a genuine but
 *   stale resident QR says `PARCEL_QR_EXPIRED`.
 * - **Serialized by the parcel's lock:** the status and the credential are
 *   read under it, so two hand-overs, a hand-over and a rejection, and a
 *   hand-over and a revoked delegate each have one winner.
 * - **A resident's QR writes nothing about the scan** (ADR 0031): no gate
 *   entry, no movement. The hand-over records the recipient on the parcel
 *   alone, and the retention sweep clears it.
 */
@Injectable()
export class ParcelHandover implements OnModuleInit {
  private readonly perMinute: number;

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly notifier: Notifier,
    private readonly shifts: ShiftsService,
    private readonly files: FilesService,
    private readonly rateLimit: RateLimitService,
    private readonly tokens: ParcelTokens,
    private readonly residents: ResidentVerifier,
    private readonly core: ParcelCore,
    config: ConfigService<Env, true>,
  ) {
    this.perMinute = config.get('PARCEL_CODE_RATE_LIMIT_PER_MINUTE', {
      infer: true,
    });
  }

  onModuleInit(): void {
    this.idempotency.renderer(PARCEL_HANDOVER_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const parcel = await tx.parcel.findUnique({ where: { id } });
        if (!parcel) throw parcelNotFound();
        return this.handedOver(tx, parcel);
      }),
    );
  }

  /**
   * What a typed code or a scanned QR is, here and now: read-only, so no
   * Idempotency-Key. The delegate's name is shown here, after a valid
   * delegate code, so the guard can compare it with the person's ID.
   */
  async lookup(input: CodeInput): Promise<ParcelLookup> {
    const field = exactlyOne({ ...input }, ['code', 'qr']);
    await this.throttle();
    const tenantId = this.ctx.tenantId;
    const found = await this.tenantTx.withTenantTx(async (tx) => {
      const credential = await this.credentialByPresentation(
        tx,
        tenantId,
        field as 'code' | 'qr',
        input,
      );
      if (!credential) return null;
      const parcel = await tx.parcel.findUnique({
        where: { id: credential.parcelId },
      });
      if (parcel?.status !== 'held') return null;
      return {
        result: 'valid' as const,
        parcel: await this.core.gateParcelOf(tx, parcel),
        presentedBy: credential.kind,
        delegateName:
          credential.kind === 'delegate' ? credential.delegateName : null,
      };
    });
    if (!found) {
      await this.failed();
      return { ...INVALID };
    }
    return found;
  }

  /**
   * Hands a held parcel over, all pieces at once. `Idempotency-Key`: a retry
   * answers with the parcel as it is (re-rendered: the answer may carry a
   * delegate's name, so no body is stored).
   */
  async handOver(id: string, input: HandOverInput): Promise<ParcelHandedOver> {
    const way = exactlyOne({ ...input }, ['code', 'qr', 'residentQr']);
    await this.throttle();
    const tenantId = this.ctx.tenantId;
    const guardId = this.ctx.accountId;
    try {
      return await this.tenantTx.withTenantTx(async (tx) => {
        await this.shifts.requireOpen(tx);
        await this.idempotency.claim(tx, {
          type: PARCEL_HANDOVER_RESOURCE,
          id,
        });
        // A resident's QR is checked before the parcel is read or locked:
        // the mac first, in ADR 0031's order. Its eligibility comes after.
        const resident =
          way === 'residentQr'
            ? await this.identify(tx, tenantId, input.residentQr ?? '')
            : null;
        await this.core.lock(tx, id);
        const parcel = await tx.parcel.findUnique({ where: { id } });
        // Ids are not secret and cannot be enumerated: an unknown one, or
        // another compound's, is simply not found.
        if (!parcel) throw parcelNotFound();
        if (parcel.status !== 'held') throw stateConflict(parcel.status);

        let method: ParcelMethod;
        let delegate: ParcelCredential | null = null;
        let recipient: string | null = null;
        if (resident) {
          if (!(await this.core.isEligible(tx, resident, parcel.unitId)))
            throw codeInvalid();
          method = 'resident_qr';
          recipient = resident;
        } else {
          const credential = await this.credentialByPresentation(
            tx,
            tenantId,
            way as 'code' | 'qr',
            input,
          );
          // Read under the lock: a revoked delegate's code is gone.
          if (!credential || credential.parcelId !== id) throw codeInvalid();
          delegate = credential.kind === 'delegate' ? credential : null;
          method = delegate ? 'delegate' : 'code';
        }

        let handoverPhotoFileId: string | null = null;
        if (input.photoFileId) {
          const file = await this.files.claim(
            tx,
            input.photoFileId,
            'parcel_photo',
          );
          if (!file)
            throw appError.badRequest(
              ErrorCode.VALIDATION_FAILED,
              'The photo is not available',
              {
                fields: [
                  {
                    field: 'photoFileId',
                    code: FieldErrorCode.FILE_NOT_AVAILABLE,
                  },
                ],
              },
            );
          await this.files.attach(tx, file);
          handoverPhotoFileId = file.id;
        }

        const now = new Date();
        const closed = await tx.parcel.update({
          where: { id },
          data: {
            status: 'handed_over',
            handedOverAt: now,
            closedAt: now,
            handedOverMethod: method,
            handedToId: recipient,
            handoverPhotoFileId,
          },
        });
        await this.core.endCredentials(tx, id, 'handed_over');
        await this.core.event(tx, {
          parcelId: id,
          kind: 'handed_over',
          side: 'guard',
          actorId: guardId,
          method,
        });
        await this.audit.record(tx, {
          action: 'parcel.handed_over',
          targetId: id,
          metadata: { method },
        });
        // The unit's other residents: how it went, never to whom.
        const unitCode = await this.core.unitCodeOf(tx, parcel.unitId);
        const others = (await this.core.eligibleOf(tx, parcel.unitId)).filter(
          (a) => a !== recipient,
        );
        await this.notifier.notify(tx, others, {
          kind: 'parcel.collected',
          targetId: id,
          params: {
            carrier: parcel.carrier,
            pieces: parcel.pieces,
            unitCode,
            method,
          },
        });
        return {
          ...this.core.gateParcel(closed, unitCode),
          delegateName: delegate?.delegateName ?? null,
        };
      });
    } catch (error) {
      if (
        error instanceof AppException &&
        error.code === ErrorCode.PARCEL_CODE_INVALID
      )
        await this.failed();
      throw error;
    }
  }

  /** `held` → `returned` is `ParcelsService.markReturned`; the shared answer. */
  private async handedOver(
    tx: TenantTxClient,
    parcel: Parcel,
  ): Promise<ParcelHandedOver> {
    const delegate = await tx.parcelCredential.findFirst({
      where: {
        parcelId: parcel.id,
        kind: 'delegate',
        endReason: 'handed_over',
      },
    });
    return {
      ...(await this.core.gateParcelOf(tx, parcel)),
      delegateName: delegate?.delegateName ?? null,
    };
  }

  /**
   * The account behind a resident QR: the mac before any read, a genuine but
   * stale QR is the one distinct answer; the rest is the unknown answer.
   */
  private async identify(
    tx: TenantTxClient,
    tenantId: string,
    raw: string,
  ): Promise<string> {
    const qr = parseEntryQr(raw);
    if (!qr) throw codeInvalid();
    const who = await this.residents.identify(tx, tenantId, qr);
    if (who.kind === 'ok') return who.accountId;
    if (who.kind === 'refused' && who.reason === 'expired_qr')
      throw appError.forbidden(
        ErrorCode.PARCEL_QR_EXPIRED,
        'This QR has expired: ask for a fresh one',
      );
    throw codeInvalid();
  }

  /** The live credential a typed code or a scanned QR names, in this compound. */
  private async credentialByPresentation(
    tx: TenantTxClient,
    tenantId: string,
    field: 'code' | 'qr',
    input: CodeInput,
  ): Promise<ParcelCredential | null> {
    if (field === 'code') {
      const code = (input.code ?? '').trim();
      if (!SIX_DIGITS.test(code)) return null;
      return tx.parcelCredential.findFirst({
        where: { codeHash: this.tokens.codeHashOf(tenantId, code) },
      });
    }
    const token = this.tokens.parseQr(input.qr ?? '');
    if (!token) return null;
    return tx.parcelCredential.findFirst({
      where: { qrTokenHash: this.tokens.qrHashOf(tenantId, token) },
    });
  }

  /**
   * The shift first (a guard off duty learns nothing), then the lockout, then
   * the budget: one for the lookup and the hand-over, whatever the way.
   */
  private async throttle(): Promise<void> {
    await this.tenantTx.withTenantTx((tx) => this.shifts.requireOpen(tx));
    const accountId = this.ctx.accountId;
    if (
      await this.rateLimit.exceeded(
        this.failureKey(accountId),
        PARCEL_FAILURE_LIMIT - 1,
      )
    )
      throw appError.tooManyRequests(
        ErrorCode.RATE_LIMITED,
        'Too many wrong codes, try again later',
      );
    await this.rateLimit.consume(
      `gate-parcel:account:${accountId}`,
      this.perMinute,
      60,
    );
  }

  /** A wrong presentation: five in the window lock the guard out. */
  private async failed(): Promise<void> {
    await this.rateLimit.hit(
      this.failureKey(this.ctx.accountId),
      PARCEL_LOCKOUT_SECONDS,
    );
  }

  private failureKey(accountId: string): string {
    return `gate-parcel-fail:account:${accountId}`;
  }
}
