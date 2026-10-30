import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { normalizeIdNumber } from '../../core/common/id-number';
import type { Env } from '../../core/config/env.schema';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { dbNow } from '../db-clock';
import { ShiftsService } from '../shifts/shifts.service';
import { SafetyCore } from '../safety/safety-core';
import { BlocklistMatcher } from './blocklist-matcher';
import { BlocklistService, type BlocklistRecord } from './blocklist.service';

/**
 * The guard's ID lookup (ADR 0053), `gate.operate` inside an open shift at
 * a gate, on the guard's own rate limit: the full ID number on the card
 * someone shows, matched against the blocklist by its keyed hash. It
 * answers the live entries of that person (kind, name, face) and nothing
 * else; the number is never stored or logged. A match is recorded and the
 * keepers are told; every lookup is audited by the entries' ids.
 */
@Injectable()
export class IdLookupService {
  private readonly perMinute: number;

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly shifts: ShiftsService,
    private readonly safety: SafetyCore,
    private readonly rateLimit: RateLimitService,
    private readonly matcher: BlocklistMatcher,
    private readonly blocklist: BlocklistService,
    config: ConfigService<Env, true>,
  ) {
    this.perMinute = config.get('GATE_VERIFY_RATE_LIMIT_PER_MINUTE', {
      infer: true,
    });
  }

  async lookup(raw: string): Promise<BlocklistRecord[]> {
    const idNumber = normalizeIdNumber(raw);
    if (!idNumber)
      throw appError.badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Invalid ID number',
        {
          fields: [{ field: 'idNumber', code: FieldErrorCode.INVALID_FORMAT }],
        },
      );
    // The shift first: a guard off duty learns nothing about anyone.
    await this.tenantTx.withTenantTx((tx) => this.shifts.requireOpen(tx));
    await this.rateLimit.consume(
      `gate-id:account:${this.ctx.accountId}`,
      this.perMinute,
      60,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      // The account, then the shift, FOR SHARE (ADR 0056's lock order):
      // what this records is stamped with a shift still open; its end
      // waits, or came first and the guard is refused.
      await this.safety.lockSelf(tx);
      const shift = await this.shifts.requireOpenLocked(tx);
      const met = await this.matcher.check(tx, { idNumbers: [idNumber] });
      await this.matcher.record(tx, met, {
        source: 'id_lookup',
        outcome: 'noted',
        gateId: shift.gateId,
        shiftId: shift.id,
      });
      await this.audit.record(tx, {
        action: 'gate.id_lookup',
        targetId: shift.id,
        metadata: {
          entryIds: met.entries.map((e) => e.id),
          matches: met.entries.length,
        },
      });
      return this.blocklist.records(tx, met.entries, await dbNow(tx));
    });
  }
}
