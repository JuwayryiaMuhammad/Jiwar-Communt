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
import { ShiftsService } from '../shifts/shifts.service';
import { EntriesService } from './entries.service';
import { GateSubjects, type GateSubject, type Refusal } from './subjects';

export interface VerifyDisplay {
  unitCode: string;
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
}

export interface VerifyResult {
  result: 'valid' | 'invalid';
  subject: 'visitor' | 'worker' | null;
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
 * rate limit.
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
    await this.tenantTx.withTenantTx((tx) => this.shifts.requireOpen(tx));
    // One budget for both inputs: a QR is no way around the code's limit.
    await this.rateLimit.consume(
      `gate-verify:account:${this.ctx.accountId}`,
      this.perMinute,
      60,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      const subject =
        input.qr !== undefined
          ? await this.byQr(tx, tenantId, input.qr)
          : await this.byCode(tx, tenantId, (input.code ?? '').trim());
      if (!subject) return { ...UNKNOWN };
      const tz = (await this.settings.inTx(tx, tenantId)).timezone;
      const inside = await this.entries.isInside(tx, subject.type, subject.id);
      // Someone inside may always leave; coming in is checked now.
      const refusal = inside
        ? null
        : await this.subjects.refusal(tx, subject, new Date(), tz);
      const isWorker = subject.type === 'worker_engagement';
      return {
        result: refusal ? 'invalid' : 'valid',
        subject: isWorker ? 'worker' : 'visitor',
        reason: refusal,
        subjectId:
          !refusal || (isWorker && refusal === 'outside_schedule')
            ? subject.id
            : null,
        next: refusal ? null : inside ? 'out' : 'in',
        display: {
          unitCode: subject.unitCode,
          passKind: isWorker ? null : subject.kind,
          partySize: isWorker ? null : subject.partySize,
          workerName: subject.workerName,
          capacity: isWorker ? subject.kind : null,
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
