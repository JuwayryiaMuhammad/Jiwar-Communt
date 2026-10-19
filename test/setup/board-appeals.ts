import { boardMatterHelpers, type Who } from './board-matters';
import type { Compound } from './community';
import { dbClock } from './compound-clock';
import { fileHelpers } from './files';
import { financeHelpers } from './finance';
import { superuserSql } from './governance';
import type { HttpHarness } from './http-app';

export interface AppealBody {
  id: string;
  reference: string;
  kind: string;
  subjectId: string;
  unitCode: string;
  status: string;
  mine: boolean;
  grounds: string | null;
  decision: { outcome: string; rationale: string } | null;
  subject: Record<string, unknown> | null;
}

/**
 * Helpers for appeals to the board (ADR 0055) on top of the board's: a
 * rejected invoice dispute of a unit (its subject), lodged over HTTP.
 */
export function boardAppealHelpers(h: HttpHarness) {
  const b = boardMatterHelpers(h);
  const fin = financeHelpers(h);
  const { http } = b;

  /** An invoice to the unit, disputed by `opener` and rejected by the manager: its id. */
  async function rejectedDispute(
    manager: Who,
    opener: Who,
    unitId: string,
  ): Promise<string> {
    const { invoiceId } = await fin.issue(manager, unitId);
    const opened = await http(
      'post',
      `/invoices/${invoiceId}/disputes`,
      opener.token,
      { reasonCode: 'wrong_amount' },
    ).expect(201);
    const id = (opened.body as { id: string }).id;
    await http('post', `/staff/invoice-disputes/${id}/decide`, manager.token, {
      decision: 'reject',
      reasonCode: 'charge_is_correct',
    }).expect(201);
    return id;
  }

  const lodge = (
    as: Who,
    subjectId: string,
    over: Record<string, unknown> = {},
  ) =>
    http('post', '/governance/board-appeals', as.token, {
      kind: 'invoice_dispute',
      subjectId,
      grounds: 'The charge was paid in cash at the office.',
      ...over,
    });

  async function appeal(
    as: Who,
    subjectId: string,
    over: Record<string, unknown> = {},
  ): Promise<AppealBody> {
    const res = await lodge(as, subjectId, over);
    if (res.status !== 201)
      throw new Error(`lodge: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as AppealBody;
  }

  const proposeOn = (
    member: Who,
    appealId: string,
    over: Record<string, unknown> = {},
  ) =>
    http('post', `/board/appeals/${appealId}/motions`, member.token, {
      outcome: 'overturn',
      rationale: 'The receipt shows the payment.',
      ...over,
    });

  /** The account becomes an owner (not residing) of the unit too. */
  const coOwn = (c: Compound, manager: Who, account: Who, unitId: string) =>
    http('post', `/residents/${account.id}/occupancies`, manager.token, {
      unitId,
      occupancyType: 'owner',
      resides: false,
    }).expect(201);

  /** The dispute's decision moved back `days`: time travel. */
  const decidedDaysAgo = (disputeId: string, days: number) =>
    superuserSql(`UPDATE invoice_disputes SET decided_at = $2 WHERE id = $1`, [
      disputeId,
      new Date(dbClock().getTime() - days * 86_400_000),
    ]);

  /** An appeal's deadline moved into the past. */
  const appealOverdue = (appealId: string) =>
    superuserSql(
      `UPDATE governance_board_appeals SET deadline_at = $2,
              lodged_at = $2::timestamptz - interval '30 days',
              decision_at = $2::timestamptz - interval '31 days'
        WHERE id = $1`,
      [appealId, new Date(dbClock().getTime() - 60_000)],
    );

  return {
    ...b,
    fin,
    files: fileHelpers(h),
    rejectedDispute,
    lodge,
    appeal,
    proposeOn,
    coOwn,
    decidedDaysAgo,
    appealOverdue,
  };
}
