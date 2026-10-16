import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CommunityGovernancePort } from '../../community';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';

const reference = (prefix: 'GP' | 'GE', n: number) =>
  `${prefix}-${String(n).padStart(4, '0')}`;

/**
 * The governance section of a personal-data export (ADR 0051),
 * `governance/`:
 *
 * - `board-seats.json`: the account's seats on the board, with their terms;
 * - `candidacies.json`: its candidacies, with its statement while it lasts,
 *   and their outcome;
 * - `votes.json`: per poll or election and per unit whose vote it cast or
 *   could cast, whether the unit voted, when and by it; the choice only on
 *   an open poll (it was never stored for a secret one).
 *
 * Never anyone else's: no other candidate, no other unit's vote.
 */
@Injectable()
export class GovernanceExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
    private readonly community: CommunityGovernancePort,
  ) {}

  onModuleInit(): void {
    this.sections.register('governance', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    const me = s.accountId;
    const data = await this.tenantTx.withTenantTx(async (tx) => {
      const seats = await tx.boardMember.findMany({
        where: { accountId: me },
        orderBy: [{ addedAt: 'asc' }, { id: 'asc' }],
      });
      const terms = await tx.boardTerm.findMany({
        where: { id: { in: [...new Set(seats.map((m) => m.termId))] } },
      });
      const candidacies = await tx.governanceCandidate.findMany({
        where: { accountId: me },
        orderBy: [{ nominatedAt: 'asc' }, { id: 'asc' }],
      });
      const elections = await tx.governanceElection.findMany({
        where: {
          id: { in: [...new Set(candidacies.map((c) => c.electionId))] },
        },
      });
      const electors = await tx.governanceElector.findMany({
        where: { accountId: me },
        orderBy: [{ contestId: 'asc' }, { unitId: 'asc' }],
      });
      const contestIds = [...new Set(electors.map((e) => e.contestId))];
      const participations = await tx.$queryRaw<
        {
          contest_id: string;
          unit_id: string;
          voter_account_id: string;
          voted_at: Date;
          choice: string[] | null;
        }[]
      >`
        SELECT p.contest_id, p.unit_id, p.voter_account_id, p.voted_at,
               p.choice::text[] AS choice
          FROM governance_participations p
          JOIN governance_electors e
            ON e.tenant_id = p.tenant_id AND e.contest_id = p.contest_id
           AND e.unit_id = p.unit_id
         WHERE e.account_id = ${me}::uuid`;
      const polls = await tx.governancePoll.findMany({
        where: { contestId: { in: contestIds } },
      });
      const votedElections = await tx.governanceElection.findMany({
        where: { contestId: { in: contestIds } },
      });
      const options = await tx.governancePollOption.findMany({
        where: { pollId: { in: polls.map((p) => p.id) } },
      });
      return {
        seats,
        terms: new Map(terms.map((t) => [t.id, t])),
        candidacies,
        elections: new Map(elections.map((e) => [e.id, e])),
        electors,
        participations,
        polls: new Map(polls.map((p) => [p.contestId, p])),
        votedElections: new Map(votedElections.map((e) => [e.contestId, e])),
        options: new Map(options.map((o) => [o.id, o])),
        codes: await this.community.unitCodes(
          tx,
          electors.map((e) => e.unitId),
        ),
      };
    });
    yield {
      path: 'governance/board-seats.json',
      json: data.seats.map((m) => {
        const t = data.terms.get(m.termId);
        return {
          role: m.role,
          addedAt: m.addedAt,
          endedAt: m.endedAt,
          endReason: m.endReason,
          term: t
            ? {
                source: t.source,
                startsAt: t.startsAt,
                endsAt: t.endsAt,
                endedAt: t.endedAt,
              }
            : null,
        };
      }),
    };
    yield {
      path: 'governance/candidacies.json',
      json: data.candidacies.map((c) => {
        const e = data.elections.get(c.electionId);
        return {
          election: e ? reference('GE', e.number) : null,
          status: c.status,
          reasonCode: c.reasonCode,
          statement: c.statement,
          nominatedAt: c.nominatedAt,
          endedAt: c.endedAt,
          votes: c.finalCount,
          outcome: c.outcome,
        };
      }),
    };
    yield {
      path: 'governance/votes.json',
      json: data.electors.map((e) => {
        const poll = data.polls.get(e.contestId);
        const election = data.votedElections.get(e.contestId);
        const p = data.participations.find(
          (x) => x.contest_id === e.contestId && x.unit_id === e.unitId,
        );
        return {
          contest: poll
            ? reference('GP', poll.number)
            : election
              ? reference('GE', election.number)
              : null,
          unitCode: data.codes.get(e.unitId) ?? null,
          voted: Boolean(p),
          votedAt: p?.voted_at ?? null,
          votedByYou: p ? p.voter_account_id === me : false,
          // An open poll's choice; a secret one was never stored with it.
          choice:
            p?.choice?.map((id) => {
              const o = data.options.get(id);
              return o
                ? { key: o.key, labelEn: o.labelEn, labelAr: o.labelAr }
                : null;
            }) ?? null,
        };
      }),
    };
  }
}
