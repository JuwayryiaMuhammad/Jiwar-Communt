import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityGovernancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { GovernanceAccess } from '../access';
import { BoardService } from '../board/board.service';
import { dbNow } from '../db-clock';
import { GovernanceNotices } from '../governance-notices';
import { electionPhase } from './election-rules';
import {
  GovernanceElectionsService,
  type ElectionRecord,
} from './elections.service';

export const GOVERNANCE_CERTIFICATION_RESOURCE = 'governance_certification';

/** `months` calendar months after `from` (the last day when it overflows). */
export function addMonths(from: Date, months: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * The certification of an election (ADR 0051), by the manager, once its
 * count is written. A tie across the last seat is resolved first: the
 * board's choice among the tied (`tieBreak`, exactly the seats left) and
 * how it chose (`governanceTieBreak`). Then, under the compound's board
 * lock: the open term ends (`succeeded`), the elected board sits from now
 * for the election's term, its winners seated as members (the offices are
 * recorded afterwards), and everyone told. A winner who owns no unit any
 * more is `ineligible`: the seat stays vacant, nobody moves up.
 */
@Injectable()
export class CertificationService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: GovernanceAccess,
    private readonly community: CommunityGovernancePort,
    private readonly elections: GovernanceElectionsService,
    private readonly board: BoardService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly notices: GovernanceNotices,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(GOVERNANCE_CERTIFICATION_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const term = await tx.boardTerm.findUniqueOrThrow({ where: { id } });
        return { electionId: term.electionId, termId: term.id };
      }),
    );
  }

  certify(
    id: string,
    input: { tieBreak?: string[]; tieReasonCode?: string },
  ): Promise<ElectionRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      // Accounts first (ADR 0036): the winners it seats and everyone it
      // tells, before the board lock.
      await this.access.lockAccounts(tx, await this.told(tx, id));
      await this.access.lockBoard(tx);
      // The term before the contest (step 3 before 4): a member cancelling
      // the election holds the term shared and waits for the contest.
      const open = await this.board.lockOpenTerm(tx);
      const { election, contest } = await this.elections.lockElection(
        tx,
        id,
        'update',
      );
      const now = await dbNow(tx);
      const phase = electionPhase(election, contest, now);
      if (phase === 'certified' || phase === 'cancelled')
        throw appError.conflict(
          ErrorCode.GOVERNANCE_CONTEST_ENDED,
          'The election ended already',
          { params: { status: phase } },
        );
      if (!contest.closedAt)
        throw appError.conflict(
          ErrorCode.GOVERNANCE_NOT_CERTIFIABLE,
          'Voting has not been counted yet',
          { params: { phase } },
        );
      const candidates = await tx.governanceCandidate.findMany({
        where: { electionId: id, status: 'nominated' },
        orderBy: { id: 'asc' },
      });
      const elected = candidates.filter((c) => c.outcome === 'elected');
      const tied = candidates.filter((c) => c.outcome === 'tied');
      const remaining = election.seats - elected.length;

      // The tie, resolved by the board: exactly the seats left, from the tied.
      let chosen: string[] = [];
      let tieReason: string | null = null;
      if (tied.length) {
        tieReason = requireReasonCodeOnly(
          input.tieReasonCode,
          REASON_CODES.governanceTieBreak,
        );
        chosen = [...new Set(input.tieBreak ?? [])];
        if (
          chosen.length !== remaining ||
          (input.tieBreak ?? []).length !== remaining
        )
          throw invalid([
            {
              field: 'tieBreak',
              code: FieldErrorCode.INVALID_LENGTH,
              params: { min: remaining, max: remaining },
            },
          ]);
        if (chosen.some((c) => !tied.some((t) => t.id === c)))
          throw invalid([
            { field: 'tieBreak', code: FieldErrorCode.INVALID_VALUE },
          ]);
      } else if (input.tieBreak?.length || input.tieReasonCode) {
        throw invalid([
          {
            field: input.tieBreak?.length ? 'tieBreak' : 'tieReasonCode',
            code: FieldErrorCode.FIELD_NOT_ALLOWED,
          },
        ]);
      }

      const termId = newId();
      await this.idempotency.claim(tx, {
        type: GOVERNANCE_CERTIFICATION_RESOURCE,
        id: termId,
      });
      const winners = [
        ...elected,
        ...tied.filter((t) => chosen.includes(t.id)),
      ];
      const seated: typeof winners = [];
      const ineligible: string[] = [];
      for (const w of winners)
        if (await this.community.isOwner(tx, w.accountId)) seated.push(w);
        else ineligible.push(w.id);
      for (const t of tied)
        await tx.governanceCandidate.update({
          where: { id: t.id },
          data: { outcome: chosen.includes(t.id) ? 'elected' : 'not_elected' },
        });
      for (const c of ineligible)
        await tx.governanceCandidate.update({
          where: { id: c },
          data: { outcome: 'ineligible' },
        });

      if (open) await this.board.endTerm(tx, open, now, 'succeeded', termId);
      const term = await tx.boardTerm.create({
        data: {
          id: termId,
          tenantId: this.ctx.txTenantId,
          source: 'elected',
          electionId: id,
          seats: election.seats,
          startsAt: now,
          endsAt: addMonths(now, election.termMonths),
          createdById: this.ctx.accountId,
          createdAt: now,
        },
      });
      for (const w of seated)
        await this.board.seat(tx, term, w.accountId, 'member', now, 'elected');

      const certified = await tx.governanceElection.update({
        where: { id },
        data: {
          certifiedAt: now,
          certifiedById: this.ctx.accountId,
          tieReasonCode: tieReason,
        },
      });
      await this.audit.record(tx, {
        action: 'governance_election.certified',
        targetId: id,
        metadata: {
          termId,
          elected: seated.map((w) => w.id),
          ineligible,
          tied: tied.length,
          tieBreak: chosen,
          tieReasonCode: tieReason,
        },
      });
      await this.notices.send(
        tx,
        await this.told(tx, id),
        'governance_election.result',
        id,
      );
      return this.elections.load(tx, certified, null);
    });
  }

  /**
   * Whom a certification tells: the electorate and every candidate (the
   * winners among them), both fixed since voting opened.
   */
  private async told(tx: TenantTxClient, electionId: string) {
    const election = await tx.governanceElection.findUnique({
      where: { id: electionId },
      select: { contestId: true },
    });
    if (!election) return [];
    const electors = await tx.governanceElector.findMany({
      where: { contestId: election.contestId },
      select: { accountId: true },
    });
    const candidates = await tx.governanceCandidate.findMany({
      where: { electionId },
      select: { accountId: true },
    });
    return [...electors, ...candidates].map((r) => r.accountId);
  }
}
