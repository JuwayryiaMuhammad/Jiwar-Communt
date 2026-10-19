import type { Response } from 'supertest';
import { today } from '../setup/compound-clock';
import { fileHelpers } from '../setup/files';
import { superuserSql } from '../setup/governance';
import { call } from './request';
import type { World } from './world';

/** A setup call that must have made what it asked (awaited: a response). */
function created(res: Response): Response {
  if (res.status !== 201)
    throw new Error(`no-store: ${res.status} ${JSON.stringify(res.body)}`);
  return res;
}

/**
 * A real call for each of the board's matters' routes (ADR 0055), as A's
 * manager, or A's landlord sitting on A's board. `sitting` makes sure a
 * board sits with the landlord on it (the suite may have appointed another).
 */
export function boardMatterCalls(
  world: () => World,
  sitting: () => Promise<void>,
): Record<string, () => Promise<Response>> {
  const as =
    (persona: 'manager' | 'landlord' | 'owner') =>
    (method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object) =>
      call(world(), method, path, {
        token: world().a.tokens[persona],
        body: payload,
      });
  const manager = as('manager');
  const member = as('landlord');
  const owner = as('owner');
  const id = (res: Response) => (res.body as { id: string }).id;

  /** A pending request with nothing to lock: a legal escalation. */
  const aRequest = async () =>
    id(
      await manager('POST', '/staff/governance/approvals', {
        type: 'legal_escalation',
        context: 'No-store request',
        impact: 'None',
      }).expect(201),
    );
  const aMotion = async (requestId?: string) => {
    await sitting();
    return id(
      await member(
        'POST',
        `/board/approvals/${requestId ?? (await aRequest())}/motions`,
        { outcome: 'approve', rationale: 'Sound.' },
      ).expect(201),
    );
  };
  /** Approved: every seated member with a login votes for. */
  const anApproved = async () => {
    const requestId = await aRequest();
    const motionId = await aMotion(requestId);
    await member('POST', `/board/motions/${motionId}/votes`, {
      choice: 'for',
    }).expect(201);
    // Closed already when the landlord's vote decided it.
    await owner('POST', `/board/motions/${motionId}/votes`, { choice: 'for' });
    return requestId;
  };
  /**
   * An open motion whose count is decided but not closed: every seat's
   * vote written straight in (a vote through the API would close it).
   */
  const aDecidedOpenMotion = async () => {
    const motionId = await aMotion();
    await superuserSql(
      `INSERT INTO board_votes (id, tenant_id, motion_id, member_id, account_id, choice, cast_at)
       SELECT gen_random_uuid(), m.tenant_id, m.id, bm.id, bm.account_id, 'for', now()
         FROM board_motions m
         JOIN board_members bm ON bm.tenant_id = m.tenant_id AND bm.term_id = m.term_id
        WHERE m.id = $1 AND bm.ended_at IS NULL`,
      [motionId],
    );
    return motionId;
  };

  return {
    'POST /staff/governance/approvals': () =>
      manager('POST', '/staff/governance/approvals', {
        type: 'exceptional_fee',
        context: 'A pool fee',
        impact: 'Owners pay once',
        cost: '1500.00',
      }),
    'GET /staff/governance/approvals': () =>
      manager('GET', '/staff/governance/approvals'),
    'GET /staff/governance/approvals/{id}': async () =>
      manager('GET', `/staff/governance/approvals/${await aRequest()}`),
    'POST /staff/governance/approvals/{id}/withdraw': async () =>
      manager(
        'POST',
        `/staff/governance/approvals/${await aRequest()}/withdraw`,
        {
          reasonCode: 'other',
        },
      ),
    'POST /staff/governance/approvals/{id}/implemented': async () =>
      manager(
        'POST',
        `/staff/governance/approvals/${await anApproved()}/implemented`,
        {},
      ),
    'GET /staff/governance/settings': () =>
      manager('GET', '/staff/governance/settings'),
    'PATCH /staff/governance/settings': () =>
      manager('PATCH', '/staff/governance/settings', {
        items: [{ type: 'legal_escalation', deadlineDays: 14 }],
      }),
    'GET /board/approvals': async () => {
      await sitting();
      return member('GET', '/board/approvals');
    },
    'GET /board/approvals/{id}': async () => {
      await sitting();
      return member('GET', `/board/approvals/${await aRequest()}`);
    },
    'POST /board/approvals/{id}/motions': async () => {
      await sitting();
      return member('POST', `/board/approvals/${await aRequest()}/motions`, {
        outcome: 'reject',
        rationale: 'Not now.',
      });
    },
    'POST /board/motions/{id}/votes': async () =>
      member('POST', `/board/motions/${await aMotion()}/votes`, {
        choice: 'against',
      }),
    'POST /board/motions/{id}/close': async () =>
      member('POST', `/board/motions/${await aDecidedOpenMotion()}/close`),
    'POST /board/motions/{id}/withdraw': async () =>
      member('POST', `/board/motions/${await aMotion()}/withdraw`),
  };
}

/**
 * A real call for each budget and expense route (ADR 0055), as A's
 * manager. One budget is made active for this year (the board's votes: A's
 * landlord's, and A's owner's when the suite's own board sits), one drafted
 * for next year; the draft route drafts last year's.
 */
export function budgetCalls(
  world: () => World,
  sitting: () => Promise<void>,
): Record<string, () => Promise<Response>> {
  const as =
    (persona: 'manager' | 'landlord' | 'owner') =>
    (
      method: 'GET' | 'POST' | 'PATCH' | 'PUT',
      path: string,
      payload?: object,
    ) =>
      call(world(), method, path, {
        token: world().a.tokens[persona],
        body: payload,
      });
  const manager = as('manager');
  const id = (res: Response) => (res.body as { id: string }).id;
  /** The fiscal year under way (A's starts in January). */
  const thisYear = () => Number(today().slice(0, 4));

  let active: Promise<{ budgetId: string; lineId: string }> | null = null;
  const anActive = () =>
    (active ??= (async () => {
      await sitting();
      const budgetId = id(
        await manager('POST', '/staff/finance/budgets', {
          fiscalYear: thisYear(),
        }).expect(201),
      );
      await manager('PUT', `/staff/finance/budgets/${budgetId}/lines`, {
        lines: [{ category: 'maintenance', amount: '100000.00' }],
      }).expect(200);
      const requestId = id(
        await manager('POST', '/staff/governance/approvals', {
          type: 'annual_budget',
          budgetId,
          context: 'No-store budget',
          impact: 'The year',
        }).expect(201),
      );
      const motionId = id(
        await as('landlord')('POST', `/board/approvals/${requestId}/motions`, {
          outcome: 'approve',
          rationale: 'Sound.',
        }).expect(201),
      );
      await as('landlord')('POST', `/board/motions/${motionId}/votes`, {
        choice: 'for',
      }).expect(201);
      // Closed already when the landlord's vote decided it.
      await as('owner')('POST', `/board/motions/${motionId}/votes`, {
        choice: 'for',
      });
      const view = (
        await manager('GET', `/staff/finance/budgets/${budgetId}`).expect(200)
      ).body as { status: string; lines: { id: string }[] };
      if (view.status !== 'active')
        throw new Error(`no-store: the budget is ${view.status}`);
      return { budgetId, lineId: view.lines[0].id };
    })());
  let next: Promise<string> | null = null;
  const aDraft = () =>
    (next ??= (async () =>
      id(
        await manager('POST', '/staff/finance/budgets', {
          fiscalYear: thisYear() + 1,
        }).expect(201),
      ))());
  const recordOne = async () => {
    const { lineId } = await anActive();
    return manager('POST', '/staff/finance/expenses', {
      budgetLineId: lineId,
      vendor: 'No-store vendor',
      amount: '10.00',
      spentOn: today(),
      invoiceFileId: await fileHelpers(world().h).ready(
        world().a.tokens.manager,
        'expense_invoice',
        'application/pdf',
      ),
    });
  };
  const anExpense = async () => id(created(await recordOne()));

  return {
    'GET /staff/finance/budget-settings': () =>
      manager('GET', '/staff/finance/budget-settings'),
    // The month it is already: a change is refused once a budget exists.
    'PATCH /staff/finance/budget-settings': () =>
      manager('PATCH', '/staff/finance/budget-settings', {
        fiscalYearStartMonth: 1,
      }),
    'POST /staff/finance/budgets': () =>
      manager('POST', '/staff/finance/budgets', {
        fiscalYear: thisYear() - 1,
      }),
    'GET /staff/finance/budgets': () =>
      manager('GET', '/staff/finance/budgets'),
    'GET /staff/finance/budgets/{id}': async () =>
      manager('GET', `/staff/finance/budgets/${await aDraft()}`),
    'PUT /staff/finance/budgets/{id}/lines': async () =>
      manager('PUT', `/staff/finance/budgets/${await aDraft()}/lines`, {
        lines: [{ category: 'other', amount: '10.00' }],
      }),
    'POST /staff/finance/expenses': () => recordOne(),
    'GET /staff/finance/expenses': () =>
      manager('GET', '/staff/finance/expenses'),
    'GET /staff/finance/expenses/{id}': async () =>
      manager('GET', `/staff/finance/expenses/${await anExpense()}`),
    'POST /staff/finance/expenses/{id}/void': async () =>
      manager('POST', `/staff/finance/expenses/${await anExpense()}/void`, {
        reasonCode: 'entered_in_error',
      }),
    'GET /staff/finance/expense-authorizations': () =>
      manager('GET', '/staff/finance/expense-authorizations'),
    'GET /staff/finance/reports/budget-vs-actual': async () => {
      await anActive();
      return manager('GET', '/staff/finance/reports/budget-vs-actual');
    },
    'GET /staff/finance/reports/budget-vs-actual/export': async () => {
      await anActive();
      return manager('GET', '/staff/finance/reports/budget-vs-actual/export');
    },
  };
}
