import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { StoredFile } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  localToday,
  parseEgyptianNationalId,
} from '../../core/common/egyptian-national-id';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { normalizeIdNumber } from '../../core/common/id-number';
import { isRealDate } from '../../core/common/validation/local-date';
import type { Env } from '../../core/config/env.schema';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { BlocklistMatcher } from '../blocklist/blocklist-matcher';
import {
  BlocklistService,
  type BlocklistRecord,
} from '../blocklist/blocklist.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { noOpenShift, ShiftsService } from '../shifts/shifts.service';
import {
  callVendor,
  driverChoice,
  vendorTimeout,
  vendorUnavailable,
} from '../vendors/vendor-call';
import {
  ID_SCAN_DRIVER,
  type IdReading,
  type IdScanDriver,
} from './id-scan-driver';

export const ID_SCAN_ORPHAN_SWEEP = 'gate.id_scan_orphans';
/** An image left behind (the process died between read and delete) goes after this. */
const ORPHAN_AFTER_MS = 60 * 60_000;
const SWEEP_BATCH = 200;

/** What the guard's device is shown, once, and nothing keeps. */
export interface IdScanRead {
  documentType: IdReading['documentType'];
  number: string;
  names: { en: string | null; ar: string | null };
  birthDate: string | null;
  expiresOn: string | null;
  /** Past its expiry, by the compound's today; null when it shows none. */
  expired: boolean | null;
  /** A national ID's own check: its birth date and governorate agree. */
  nationalId: { valid: boolean; birthDate: string | null } | null;
  matches: BlocklistRecord[];
}

const unreadable = () =>
  appError.unprocessable(
    ErrorCode.ID_SCAN_UNREADABLE,
    'The document could not be read: type its number instead',
  );

/**
 * A guard's ID scan (ADR 0068). On an open shift at a gate, on the guard's
 * own rate limit, the guard photographs a document; the ID-scan vendor
 * reads it; our checks run on what it read — the number's shape, a
 * national ID's own structure, expiry — and the number meets the
 * blocklist as an ID lookup's does (`id_scan`, noted, the keepers told).
 *
 * What was read goes to the guard's device once, no-store, and nowhere
 * else: no idempotency record, no audit beyond the outcome and the
 * document's type and whether it met an entry, never a log (bodies are
 * never logged). The image is deleted whatever came of it — at once, and by
 * a sweep if the process died in between.
 *
 * Two transactions around the vendor: the first takes the account, then
 * the shift (ADR 0056), and claims the image; the vendor reads it outside
 * any transaction; the second takes them again before anything is
 * recorded. A shift ended in between records nothing.
 */
@Injectable()
export class IdScansService implements OnModuleInit {
  private readonly perMinute: number;
  private readonly timeoutMs: number;
  private readonly isOff: boolean;

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly rateLimit: RateLimitService,
    private readonly sweep: SweepRunner,
    private readonly settings: TenantSettingsService,
    private readonly shifts: ShiftsService,
    private readonly safety: SafetyCore,
    private readonly matcher: BlocklistMatcher,
    private readonly blocklist: BlocklistService,
    @Inject(ID_SCAN_DRIVER) private readonly driver: IdScanDriver,
    config: ConfigService<Env, true>,
  ) {
    this.perMinute = config.get('GATE_VERIFY_RATE_LIMIT_PER_MINUTE', {
      infer: true,
    });
    this.timeoutMs = vendorTimeout(config);
    this.isOff = driverChoice(config, 'id_scan') === 'off';
  }

  onModuleInit(): void {
    this.sweep.register(ID_SCAN_ORPHAN_SWEEP, (now) => this.orphans(now));
  }

  async scan(imageFileId: string): Promise<IdScanRead> {
    if (this.isOff) throw vendorUnavailable('id_scan', true);
    // The shift first: a guard off duty learns nothing about anyone.
    await this.tenantTx.withTenantTx((tx) => this.shifts.requireOpen(tx));
    await this.rateLimit.consume(
      `gate-id-scan:account:${this.ctx.accountId}`,
      this.perMinute,
      60,
    );
    const { shiftId, file } = await this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const shift = await this.shifts.requireOpenLocked(tx);
      const claimed = await this.files.claim(tx, imageFileId, 'gate_id_scan');
      if (!claimed)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Not a scan of yours',
          {
            fields: [
              { field: 'imageFileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
            ],
          },
        );
      return { shiftId: shift.id, file: claimed };
    });
    try {
      const bytes = await this.files.contents(file);
      if (!bytes) throw unreadable();
      const reading = await callVendor('id_scan', this.timeoutMs, (signal) =>
        this.driver.read(
          {
            tenantId: this.ctx.txTenantId,
            image: { bytes, contentType: file.contentType },
          },
          signal,
        ),
      );
      return await this.record(shiftId, reading);
    } finally {
      await this.discard(file);
    }
  }

  private async record(
    shiftId: string,
    reading: IdReading,
  ): Promise<IdScanRead> {
    const number = reading.number ? normalizeIdNumber(reading.number) : null;
    const result = await this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const shift = await this.shifts.requireOpenLocked(tx);
      if (shift.id !== shiftId) throw noOpenShift();
      const met = number
        ? await this.matcher.check(tx, { idNumbers: [number] })
        : { entries: [], kind: null, entry: null };
      await this.matcher.record(tx, met, {
        source: 'id_scan',
        outcome: 'noted',
        gateId: shift.gateId,
        shiftId: shift.id,
      });
      await this.audit.record(tx, {
        action: 'gate.id_scanned',
        targetId: shift.id,
        metadata: {
          outcome: number ? 'read' : 'unreadable',
          documentType: reading.documentType,
          matched: met.entries.length > 0,
        },
      });
      if (!number) return null;
      const now = await dbNow(tx);
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const today = localToday(timezone, now).toISOString().slice(0, 10);
      const expiresOn = day(reading.expiresOn);
      const national =
        reading.documentType === 'national_id'
          ? parseEgyptianNationalId(number, localToday(timezone, now))
          : null;
      return {
        documentType: reading.documentType,
        number,
        names: {
          en: reading.names.en?.trim() || null,
          ar: reading.names.ar?.trim() || null,
        },
        birthDate: day(reading.birthDate),
        expiresOn,
        expired: expiresOn ? expiresOn < today : null,
        nationalId:
          reading.documentType === 'national_id'
            ? {
                valid: national !== null,
                birthDate: national
                  ? national.birthDate.toISOString().slice(0, 10)
                  : null,
              }
            : null,
        matches: await this.blocklist.records(tx, met.entries, now),
      } satisfies IdScanRead;
    });
    if (!result) throw unreadable();
    return result;
  }

  /** The image goes whatever came of the scan: marked, then its object. */
  private async discard(file: StoredFile): Promise<void> {
    await this.tenantTx.withTenantTx((tx) =>
      this.files.markDeleted(tx, file, 'read'),
    );
    await this.files.purge(file.id);
  }

  /**
   * Once an hour: a scan's image still held an hour on (the process died
   * between the read and its delete, or it was never sent) is deleted.
   */
  orphans(now: Date): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const left = await tx.storedFile.findMany({
        where: {
          purpose: 'gate_id_scan',
          deletedAt: null,
          createdAt: { lte: new Date(now.getTime() - ORPHAN_AFTER_MS) },
        },
        select: { id: true, purpose: true },
        orderBy: { createdAt: 'asc' },
        take: SWEEP_BATCH,
      });
      for (const f of left) await this.files.markDeleted(tx, f, 'read');
      return left.length;
    });
  }
}

/** A day as printed, or null when it is not one. */
const day = (v: string | null): string | null =>
  v !== null && isRealDate(v) ? v : null;
