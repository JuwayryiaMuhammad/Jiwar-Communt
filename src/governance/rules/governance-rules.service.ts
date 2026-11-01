import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { BoardMatters } from '../../core/board-matters/board-matters';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { FilesService } from '../../core/files/files.service';
import { localDate } from '../../core/common/slots/day-slots';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { GovernanceAccess } from '../access';
import { dbNow } from '../db-clock';

/** Why the system refuses a candidacy (`params.reason`). */
export const CANDIDACY_REFUSALS = ['dues_outstanding', 'staff'] as const;
export type CandidacyRefusal = (typeof CANDIDACY_REFUSALS)[number];

export interface GovernanceRulesView {
  candidacyNoDues: boolean;
  candidacyNotStaff: boolean;
  /** The compound's logo on the board's documents (ADR 0075). */
  reportLogoFileId: string | null;
  /** The monthly board report is sent on the month's first days. */
  boardReportMonthly: boolean;
  updatedAt: Date | null;
}

const DEFAULTS = {
  candidacyNoDues: false,
  candidacyNotStaff: false,
  reportLogoFileId: null as string | null,
  boardReportMonthly: true,
};

/**
 * The compound's governance rules (ADR 0075): two candidacy checks the
 * system runs at nomination, off by default. The rest of eligibility is
 * the manager's, by disqualification with a code (ADR 0051).
 */
@Injectable()
export class GovernanceRulesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: GovernanceAccess,
    private readonly audit: AuditService,
    private readonly matters: BoardMatters,
    private readonly settings: TenantSettingsService,
    private readonly files: FilesService,
  ) {}

  read(): Promise<GovernanceRulesView> {
    return this.tenantTx.withTenantTx((tx) => this.load(tx));
  }

  update(input: {
    candidacyNoDues?: boolean;
    candidacyNotStaff?: boolean;
    reportLogoFileId?: string | null;
    boardReportMonthly?: boolean;
  }): Promise<GovernanceRulesView> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      // One writer at a time: the row may not exist yet.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`governance-rules:${this.ctx.txTenantId}`}))`;
      const before = await this.load(tx);
      const next = {
        candidacyNoDues: input.candidacyNoDues ?? before.candidacyNoDues,
        candidacyNotStaff: input.candidacyNotStaff ?? before.candidacyNotStaff,
        reportLogoFileId:
          input.reportLogoFileId === undefined
            ? before.reportLogoFileId
            : input.reportLogoFileId,
        boardReportMonthly:
          input.boardReportMonthly ?? before.boardReportMonthly,
      };
      // A new logo: one of the caller's own uploads of the purpose,
      // attached to the compound from now on.
      if (
        next.reportLogoFileId &&
        next.reportLogoFileId !== before.reportLogoFileId
      ) {
        const file = await this.files.claim(
          tx,
          next.reportLogoFileId,
          'compound_logo',
        );
        if (!file)
          throw invalid([
            {
              field: 'reportLogoFileId',
              code: FieldErrorCode.FILE_NOT_AVAILABLE,
            },
          ]);
        await this.files.attach(tx, file);
      }
      const now = await dbNow(tx);
      await tx.governanceRules.upsert({
        where: { tenantId: this.ctx.txTenantId },
        create: {
          tenantId: this.ctx.txTenantId,
          ...next,
          updatedById: this.ctx.accountId,
          updatedAt: now,
        },
        update: { ...next, updatedById: this.ctx.accountId, updatedAt: now },
      });
      const changes = diffChanges(
        {
          candidacyNoDues: before.candidacyNoDues,
          candidacyNotStaff: before.candidacyNotStaff,
          reportLogoFileId: before.reportLogoFileId,
          boardReportMonthly: before.boardReportMonthly,
        },
        next,
        'governance_rules.changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'governance_rules.changed',
          targetId: this.ctx.txTenantId,
          changes,
        });
      return this.load(tx);
    });
  }

  /**
   * At a nomination, after the caller's lock: refuses the candidacy the
   * compound's rules exclude (409 GOVERNANCE_CANDIDACY_NOT_ELIGIBLE with
   * `params.reason`). The dues are finance's answer, on the compound's
   * day; the staff check matches the caller's identity document against
   * the compound's active staff and manager accounts.
   */
  async requireEligible(
    tx: TenantTxClient,
    accountId: string,
    unitIds: readonly string[],
  ): Promise<void> {
    const rules = await this.load(tx);
    if (rules.candidacyNotStaff && (await this.isStaff(tx, accountId)))
      throw notEligible('staff');
    if (rules.candidacyNoDues) {
      const { timezone } = await this.settings.inTx(tx, this.ctx.txTenantId);
      const today = localDate(await dbNow(tx), timezone);
      if (await this.matters.owesPastDue(tx, unitIds, today))
        throw notEligible('dues_outstanding');
    }
  }

  private async isStaff(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<{ staff: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM accounts me
          JOIN accounts s
            ON s.tenant_id = me.tenant_id
           AND s.id_document_type = me.id_document_type
           AND s.id_document_number = me.id_document_number
         WHERE me.id = ${accountId}::uuid
           AND me.id_document_number IS NOT NULL
           AND s.id <> me.id
           AND s.type::text IN ('staff', 'manager')
           AND s.status::text = 'active'
      ) AS staff`;
    return rows[0]?.staff ?? false;
  }

  private async load(tx: TenantTxClient): Promise<GovernanceRulesView> {
    const row = await tx.governanceRules.findUnique({
      where: { tenantId: this.ctx.txTenantId },
    });
    return row
      ? {
          candidacyNoDues: row.candidacyNoDues,
          candidacyNotStaff: row.candidacyNotStaff,
          reportLogoFileId: row.reportLogoFileId,
          boardReportMonthly: row.boardReportMonthly,
          updatedAt: row.updatedAt,
        }
      : { ...DEFAULTS, updatedAt: null };
  }
}

const notEligible = (reason: CandidacyRefusal) =>
  appError.conflict(
    ErrorCode.GOVERNANCE_CANDIDACY_NOT_ELIGIBLE,
    'The compound’s rules exclude this candidacy',
    { params: { reason } },
  );
