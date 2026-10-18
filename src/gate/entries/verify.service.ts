import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CommunityGatePort } from '../../community';
import { AccessTokens } from '../../core/auth/access-token';
import { IdentifierHasher } from '../../core/auth/identifier';
import { RequestContext } from '../../core/common/cls/request-context';
import type { Env } from '../../core/config/env.schema';
import { FilesService } from '../../core/files/files.service';
import type { PresignedRead } from '../../core/files/object-storage';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { parseEntryQr } from '../entry/entry-secrets';
import { ResidentVerifier } from '../entry/resident-verifier';
import { LockdownCore } from '../lockdown/lockdown-core';
import {
  VisitorParkingService,
  type GuardParking,
} from '../parking/visitor-parking.service';
import { ShiftsService } from '../shifts/shifts.service';
import { capacityOf, EntriesService } from './entries.service';
import { GateSubjects, type GateSubject, type Refusal } from './subjects';

export interface VerifyDisplay {
  /** Null for a resident, who may live in several units (`unitCodes`). */
  unitCode: string | null;
  /** Visitors: the pass kind and party size. */
  passKind: string | null;
  partySize: number | null;
  /** Workers: name and capacity. */
  workerName: string | null;
  capacity: string | null;
  /**
   * A valid worker's photo (ADR 0029), for the guard to compare the face;
   * never for an invalid result or a visitor.
   */
  photo: PresignedRead | null;
  /** A valid resident (ADR 0031): the first word of the name, nothing more. */
  firstName: string | null;
  /** A valid resident: the units where they live now. */
  unitCodes: string[] | null;
  /**
   * A valid resident's photo as a presigned URL, or null when they have none,
   * so the guard knows to ask for ID. Never for an invalid result.
   */
  photoUrl: string | null;
  /**
   * A valid visitor pass's vehicle plate (ADR 0043), while the visitor's
   * data lasts; null otherwise.
   */
  vehiclePlate: string | null;
  /** A one-time pass: how many of its group came in (ADR 0043). */
  entriesUsed: number | null;
  /** A visitor pass: how many on it are inside now. */
  insideCount: number | null;
  /**
   * A valid visitor pass's parking booking (ADR 0045): holding now, or the
   * next within two hours. Where and when, never who.
   */
  parking: GuardParking | null;
}

export interface VerifyResult {
  result: 'valid' | 'invalid';
  subject: 'visitor' | 'worker' | 'resident' | null;
  reason: Refusal | null;
  /** The pass or engagement, to record the entry (or ask, off schedule). */
  subjectId: string | null;
  /** `out` when they are inside now. */
  next: 'in' | 'out' | null;
  display: VerifyDisplay | null;
}

/** Unknown, malformed and another compound's codes or QRs: one answer. */
const UNKNOWN: VerifyResult = {
  result: 'invalid',
  subject: null,
  reason: 'unknown_code',
  subjectId: null,
  next: null,
  display: null,
};

/**
 * `POST /gate/verify` (ADR 0028): what a code is, here and now. Read-only
 * apart from the per-guard rate limit, so it takes no Idempotency-Key. A
 * visitor code has 6 digits, a worker code 8; a code is looked up by its
 * HMAC in this compound only, so another compound's code is just unknown.
 * A scanned QR (`JWR1.<token>`, ADR 0030) is looked up by the token's
 * compound-bound HMAC and then follows the same path: same answers, same
 * rate limit. A resident's rotating QR (`JWR2.…`, ADR 0031) is checked by
 * `ResidentVerifier`, which writes nothing at all, and comes in through a
 * lockdown (ADR 0053); everyone else is refused while one holds the gate.
 */
@Injectable()
export class VerifyService {
  private readonly perMinute: number;

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly shifts: ShiftsService,
    private readonly subjects: GateSubjects,
    private readonly entries: EntriesService,
    private readonly community: CommunityGatePort,
    private readonly hasher: IdentifierHasher,
    private readonly settings: TenantSettingsService,
    private readonly rateLimit: RateLimitService,
    private readonly tokens: AccessTokens,
    private readonly files: FilesService,
    private readonly residents: ResidentVerifier,
    private readonly parking: VisitorParkingService,
    private readonly lockdown: LockdownCore,
    config: ConfigService<Env, true>,
  ) {
    this.perMinute = config.get('GATE_VERIFY_RATE_LIMIT_PER_MINUTE', {
      infer: true,
    });
  }

  /** Exactly one of a typed code or a scanned QR (the DTO says which). */
  async verify(input: { code?: string; qr?: string }): Promise<VerifyResult> {
    const tenantId = this.ctx.tenantId;
    // The shift first: a guard off duty learns nothing about any code.
    const shift = await this.tenantTx.withTenantTx((tx) =>
      this.shifts.requireOpen(tx),
    );
    // One budget for both inputs: a QR is no way around the code's limit.
    await this.rateLimit.consume(
      `gate-verify:account:${this.ctx.accountId}`,
      this.perMinute,
      60,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const entry = input.qr !== undefined ? parseEntryQr(input.qr) : null;
      if (entry) {
        return (
          (await this.residents.verify(tx, tenantId, entry)) ?? { ...UNKNOWN }
        );
      }
      const subject =
        input.qr !== undefined
          ? await this.byQr(tx, tenantId, input.qr)
          : await this.byCode(tx, tenantId, (input.code ?? '').trim());
      if (!subject) return { ...UNKNOWN };
      // A lockdown (ADR 0053) refuses everyone coming in but a resident,
      // decided under the compound's lockdown row like the entry itself.
      await this.lockdown.lockState(tx, 'share');
      const locked = await this.lockdown.live(tx, shift.gateId);
      const tz = (await this.settings.inTx(tx, tenantId)).timezone;
      const inside = await this.entries.insideCount(
        tx,
        subject.type,
        subject.id,
      );
      // Coming in is checked now, while there is room on the subject (a
      // group pass: one person per entry, ADR 0043). Otherwise someone
      // inside may always leave.
      const entryRefusal =
        inside < capacityOf(subject)
          ? locked
            ? 'lockdown_active'
            : await this.subjects.refusal(tx, subject, new Date(), tz)
          : null;
      const canEnter = inside < capacityOf(subject) && entryRefusal === null;
      const refusal = canEnter || inside > 0 ? null : entryRefusal;
      const isWorker = subject.type === 'worker_engagement';
      const pass = subject.pass;
      return {
        result: refusal ? 'invalid' : 'valid',
        subject: isWorker ? 'worker' : 'visitor',
        reason: refusal,
        subjectId:
          !refusal || (isWorker && refusal === 'outside_schedule')
            ? subject.id
            : null,
        next: refusal ? null : canEnter ? 'in' : 'out',
        display: {
          unitCode: subject.unitCode,
          passKind: isWorker ? null : subject.kind,
          partySize: isWorker ? null : subject.partySize,
          workerName: subject.workerName,
          capacity: isWorker ? subject.kind : null,
          firstName: null,
          unitCodes: null,
          photoUrl: null,
          entriesUsed: pass?.kind === 'one_time' ? pass.entriesUsed : null,
          insideCount: pass ? inside : null,
          parking:
            pass && !refusal
              ? await this.parking.forPass(tx, pass.id, new Date())
              : null,
          vehiclePlate:
            !isWorker && !refusal && subject.visitorDetailsId
              ? ((
                  await tx.visitorDetails.findUnique({
                    where: { id: subject.visitorDetailsId },
                    select: { vehiclePlate: true },
                  })
                )?.vehiclePlate ?? null)
              : null,
          photo:
            isWorker && !refusal
              ? await this.files.readUrl(
                  tx,
                  subject.engagement?.photoFileId ?? null,
                )
              : null,
        },
      };
    });
  }

  private async byCode(
    tx: TenantTxClient,
    tenantId: string,
    code: string,
  ): Promise<GateSubject | null> {
    if (/^\d{6}$/.test(code)) {
      const pass = await tx.visitorPass.findFirst({
        where: { codeHash: this.hasher.hashVisitorCode(tenantId, code) },
      });
      return pass ? this.subjects.pass(tx, pass) : null;
    }
    if (/^\d{8}$/.test(code)) {
      const e = await this.community.engagementByCode(tx, tenantId, code);
      return e ? this.subjects.worker(e) : null;
    }
    return null;
  }

  /** A pass's or a card's token; anything that is not a Jiwar QR is unknown. */
  private async byQr(
    tx: TenantTxClient,
    tenantId: string,
    raw: string,
  ): Promise<GateSubject | null> {
    const token = this.tokens.parseQr(raw);
    if (!token) return null;
    const pass = await tx.visitorPass.findFirst({
      where: { qrTokenHash: this.hasher.hashQrToken(tenantId, token) },
    });
    if (pass) return this.subjects.pass(tx, pass);
    const e = await this.community.engagementByQr(tx, tenantId, token);
    return e ? this.subjects.worker(e) : null;
  }
}
