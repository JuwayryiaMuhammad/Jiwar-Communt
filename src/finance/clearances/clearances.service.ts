import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FinanceClearance } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { CommunityFinancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import type { Env } from '../../core/config/env.schema';
import { newId } from '../../core/common/uuid';
import { GlobalDbService } from '../../core/database/global-db.service';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import {
  drawCertificate,
  type CertificateTemplate,
} from '../../core/pdf/certificate';
import { PdfRenderer } from '../../core/pdf/pdf-renderer';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { FinanceAccess } from '../access';
import { formatNumber, takeNumbers } from '../counters';
import { asDate, dbNow, fromDate, localToday } from '../db-clock';
import { balancesOf, CREDITED_SQL, PAID_SQL } from '../invoices/balances';
import { show, ZERO } from '../money';

/** Days a clearance is valid from its instant. */
export const CLEARANCE_VALID_DAYS = 30;
export const CLEARANCE_CODE = /^[A-Za-z0-9_-]{22}$/;

export interface ClearanceRead {
  id: string;
  number: string;
  unitId: string;
  unitCode: string;
  asOf: Date;
  validUntil: string;
  verifyCode: string;
}

/** What anyone holding a clearance's code may read: no names. */
export interface PublicClearance {
  compoundName: string;
  number: string;
  unitCode: string;
  asOf: Date;
  validUntil: string;
  status: 'valid' | 'expired';
}

const notFound = () =>
  appError.notFound(ErrorCode.CLEARANCE_NOT_FOUND, 'Clearance not found');
export const clearanceCodeHash = (code: string) =>
  createHash('sha256').update(code, 'utf8').digest('hex');

/**
 * Clearance certificates (ADR 0062). A unit's active occupant (never a
 * delegate or a member: it is about money) or the management
 * (`finance.invoice`) asks; under the unit's finance lock — the one every
 * invoice, payment and credit note takes — the unit's balance is read, open
 * disputes included: anything owed is CLEARANCE_BALANCE_DUE with the
 * amount, nothing owed issues the certificate at once. The record never
 * changes; its PDF is drawn on demand (core PdfRenderer, certificate.v2),
 * and its code opens a public check, as a receipt's does.
 */
@Injectable()
export class ClearancesService {
  private readonly appUrl: string;

  constructor(
    config: ConfigService<Env, true>,
    private readonly ctx: RequestContext,
    private readonly tenantTx: TenantTx,
    private readonly globalDb: GlobalDbService,
    private readonly access: FinanceAccess,
    private readonly community: CommunityFinancePort,
    private readonly settings: TenantSettingsService,
    private readonly audit: AuditService,
    private readonly pdf: PdfRenderer,
  ) {
    this.appUrl = config.get('PUBLIC_APP_URL', { infer: true });
  }

  /** The unit's active occupant asks for its own clearance. */
  async ask(unitId: string): Promise<ClearanceRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const occupancyId = await this.community.activeOccupancy(
        tx,
        unitId,
        this.ctx.accountId,
      );
      if (!occupancyId)
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      return this.issue(tx, unitId, occupancyId, 'resident');
    });
  }

  /** The management issues one for a unit (a sale, a transfer). */
  async staffIssue(unitId: string): Promise<ClearanceRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      if (!(await this.community.units(tx, [unitId])).has(unitId))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      return this.issue(tx, unitId, null, 'management');
    });
  }

  /** The caller's clearances for the unit, newest first. */
  mine(unitId: string): Promise<ClearanceRead[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await this.community.units(tx, [unitId])).has(unitId))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const rows = await tx.financeClearance.findMany({
        where: { unitId, requestedBy: this.ctx.accountId },
        orderBy: { asOf: 'desc' },
        take: 50,
      });
      return this.reads(tx, rows);
    });
  }

  /** A clearance's PDF: its requester's, or the management's (`staff`). */
  certificate(
    id: string,
    staff: boolean,
  ): Promise<{ name: string; body: Buffer }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.financeClearance.findFirst({
        where: { id, ...(staff ? {} : { requestedBy: this.ctx.accountId }) },
      });
      if (!row) throw notFound();
      const [r] = await this.reads(tx, [row]);
      const building = (await this.community.units(tx, [row.unitId])).get(
        row.unitId,
      )?.building;
      const { name: compound } = await this.globalDb
        .in(tx)
        .tenant.findUniqueOrThrow({
          where: { id: row.tenantId },
          select: { name: true },
        });
      const { timezone } = await this.settings.inTx(tx, row.tenantId);
      const asOf = new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: timezone,
      }).format(row.asOf);
      const body = await this.pdf.render(
        { title: r.number, createdAt: row.asOf },
        (page) =>
          drawCertificate(page, {
            template: row.template as CertificateTemplate,
            compound,
            titleEn: 'Clearance certificate',
            titleAr: 'شهادة إخلاء طرف',
            number: r.number,
            rows: [
              // The code and the building apart: mixed in one value, the
              // Arabic word would reorder around the digits.
              { labelEn: 'Unit', labelAr: 'الوحدة', value: r.unitCode },
              ...(building
                ? [{ labelEn: 'Building', labelAr: 'المبنى', value: building }]
                : []),
              // Every amount in one form: the figure, then EGP.
              { labelEn: 'Balance', labelAr: 'الرصيد', value: '0.00 EGP' },
              { labelEn: 'As of', labelAr: 'حتى', value: asOf },
              {
                labelEn: 'Valid until',
                labelAr: 'صالحة حتى',
                value: r.validUntil,
              },
            ],
            statementEn: `The management states that unit ${r.unitCode} owed nothing to the compound as of the date above.`,
            statementAr: `تشهد الإدارة بأن الوحدة ${r.unitCode} لم يكن عليها أي مستحقات للكمبوند حتى التاريخ المذكور أعلاه.`,
            verifyUrl: `${this.appUrl}/c`,
            verifyCode: r.verifyCode,
          }),
      );
      return { name: `${r.number}.pdf`, body };
    });
  }

  // --------------------------------------------------------------------------

  private async issue(
    tx: TenantTxClient,
    unitId: string,
    occupancyId: string | null,
    side: 'resident' | 'management',
  ): Promise<ClearanceRead> {
    await this.access.lockUnits(tx, [unitId]);
    const owed = await this.owed(tx, unitId);
    if (owed.gt(ZERO))
      throw appError.conflict(
        ErrorCode.CLEARANCE_BALANCE_DUE,
        'The unit owes the compound',
        { params: { owed: show(owed) } },
      );
    const tenantId = this.ctx.txTenantId;
    const number = await takeNumbers(tx, tenantId, 'clearance');
    const { timezone } = await this.settings.inTx(tx, tenantId);
    const asOf = await dbNow(tx);
    const today = await localToday(tx, timezone);
    const validUntil = asDate(today);
    validUntil.setUTCDate(validUntil.getUTCDate() + CLEARANCE_VALID_DAYS);
    const verifyCode = randomBytes(16).toString('base64url');
    const row = await tx.financeClearance.create({
      data: {
        id: newId(),
        tenantId,
        number,
        unitId,
        occupancyId,
        requestedBy: this.ctx.accountId,
        asOf,
        validUntil,
        verifyCode,
        template: 'certificate.v2',
      },
    });
    await this.globalDb.in(tx).clearanceLink.create({
      data: {
        codeHash: clearanceCodeHash(verifyCode),
        tenantId,
        clearanceId: row.id,
        createdAt: asOf,
      },
    });
    await this.audit.record(tx, {
      action: 'clearance.issued',
      targetId: row.id,
      metadata: {
        unitId,
        number: formatNumber('clearance', number),
        side,
      },
    });
    return (await this.reads(tx, [row]))[0];
  }

  /** What the unit owes now, open disputes included. */
  private async owed(tx: TenantTxClient, unitId: string) {
    const open = await tx.$queryRaw<{ id: string }[]>`
      SELECT i.id FROM invoices i
       WHERE i.unit_id = ${unitId}::uuid
         AND i.total - ${CREDITED_SQL} - ${PAID_SQL} > 0`;
    const balances = await balancesOf(
      tx,
      open.map((o) => o.id),
    );
    return [...balances.values()].reduce(
      (sum, b) => sum.add(b.outstanding),
      ZERO,
    );
  }

  private async reads(
    tx: TenantTxClient,
    rows: FinanceClearance[],
  ): Promise<ClearanceRead[]> {
    const units = await this.community.units(
      tx,
      rows.map((r) => r.unitId),
    );
    return rows.map((r) => ({
      id: r.id,
      number: formatNumber('clearance', r.number),
      unitId: r.unitId,
      unitCode: units.get(r.unitId)?.code ?? '',
      asOf: r.asOf,
      validUntil: fromDate(r.validUntil),
      verifyCode: r.verifyCode,
    }));
  }
}
