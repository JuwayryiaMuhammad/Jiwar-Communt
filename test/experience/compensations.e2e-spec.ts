import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  experienceHelpers,
  type CompensationBody,
  type ExperienceSetUp,
} from '../setup/experience';
import type { Who } from '../setup/governance';

type Body = {
  code: string;
  params?: Record<string, unknown>;
  fields?: { field: string; code: string }[];
};

/**
 * ADR 0082: compensations on a case. Proposed by the staff, decided once by
 * the manager under the row's lock; a credit is finance's compensation
 * credit note on one of the unit's invoices; above the binding
 * compensation_above_limit threshold it is paid only with what the board
 * approved (ADR 0073), used once. The rules recommend per failure.
 */
describe('Experience — compensations', () => {
  let h: HttpHarness;
  let e: ReturnType<typeof experienceHelpers>;
  let s: ExperienceSetUp;
  let staff: Who;
  const o = (i: number) => s.owners[i - 1];

  beforeAll(async () => {
    h = await createHttpHarness();
    e = experienceHelpers(h);
    s = await e.setUp(5, 3);
    staff = await e.staff(s.c, ['experience.manage']);
  }, 180_000);

  afterAll(() => h.close());

  const manager = () => s.manager.token;

  /** An open recovery case for the owner's unit (the open one if any). */
  async function caseFor(owner = o(4)): Promise<string> {
    const [open] = (await e.casesOf(s.c, owner.unitId)).filter(
      (c) => c.status === 'open',
    );
    if (open) return open.id;
    return (
      await e.openCase(staff.token, { unitId: owner.unitId, kind: 'recovery' })
    ).id;
  }

  /** What the board approved for a compensation of `cost`: its id. */
  async function approvedByBoard(cost: string): Promise<string> {
    const r = await e.raise(s.manager, {
      type: 'compensation_above_limit',
      cost,
    });
    const before = await e
      .http(
        'get',
        '/staff/finance/board-authorizations?type=compensation_above_limit&unused=true',
        manager(),
      )
      .expect(200);
    expect(
      (before.body as { data: { approvalRequestId: string }[] }).data.some(
        (a) => a.approvalRequestId === r.id,
      ),
    ).toBe(false);
    const m = await e.motion(o(1), r.id);
    await e.vote(o(1), m.id, 'for').expect(201);
    await e.vote(o(2), m.id, 'for').expect(201);
    const after = await e
      .http(
        'get',
        '/staff/finance/board-authorizations?type=compensation_above_limit&unused=true',
        manager(),
      )
      .expect(200);
    const auth = (
      after.body as { data: { id: string; approvalRequestId: string }[] }
    ).data.find((a) => a.approvalRequestId === r.id);
    if (!auth) throw new Error('no authorization for the approved request');
    return auth.id;
  }

  it('a proposal names what failed; a credit its amount, the others none; the manager is told', async () => {
    const caseId = await caseFor();
    const fields = async (body: object) =>
      (
        (
          await e
            .api('post', `/cases/${caseId}/compensations`, staff.token, {
              failureCode: 'maintenance_delay',
              ...body,
            })
            .expect(400)
        ).body as Body
      ).fields;
    expect(await fields({ kind: 'credit' })).toEqual([
      { field: 'amount', code: 'FIELD_REQUIRED' },
    ]);
    expect(await fields({ kind: 'apology', amount: '50.00' })).toEqual([
      { field: 'amount', code: 'FIELD_NOT_ALLOWED' },
    ]);
    expect(
      (await fields({ kind: 'redo', failureCode: 'bad' }))?.[0].field,
    ).toBe('failureCode');
    const made = await e.propose(staff.token, caseId, {
      kind: 'apology',
      note: 'COMP-NOTE a call from the manager',
    });
    expect(made).toMatchObject({
      status: 'proposed',
      kind: 'apology',
      amount: null,
      authority: { decider: 'manager' },
    });
    expect(
      (
        await e.notifications(
          s.c,
          s.c.managerId,
          'experience_compensation.proposed',
        )
      ).at(-1),
    ).toMatchObject({ targetId: made.id });
    // Only the manager decides.
    await e.decide(staff.token, made.id, { decision: 'approve' }).expect(403);
    const ok = await e
      .decide(manager(), made.id, { decision: 'approve' })
      .expect(201);
    expect(ok.body).toMatchObject({
      status: 'approved',
      creditNoteId: null,
      authority: null,
    });
    const again = await e
      .decide(manager(), made.id, {
        decision: 'reject',
        reasonCode: 'not_justified',
      })
      .expect(409);
    expect(again.body).toMatchObject({
      code: 'COMPENSATION_DECIDED',
      params: { status: 'approved' },
    });
    const audit = await e.inTx(s.c, (tx) =>
      tx.auditLog.findMany({ where: { targetId: made.id } }),
    );
    expect(audit.map((a) => a.action).sort()).toEqual([
      'experience_compensation.approved',
      'experience_compensation.proposed',
    ]);
    expect(JSON.stringify(audit)).not.toContain('COMP-NOTE');
  });

  it('a rejection takes a code; a non-money approval names no invoice', async () => {
    const caseId = await caseFor();
    const one = await e.propose(staff.token, caseId, { kind: 'redo' });
    const noCode = await e
      .decide(manager(), one.id, { decision: 'reject' })
      .expect(400);
    expect((noCode.body as Body).code).toBe('REASON_REQUIRED');
    const extra = await e
      .decide(manager(), one.id, {
        decision: 'approve',
        invoiceId: '0193b8a4-0000-7000-8000-000000000000',
      })
      .expect(400);
    expect((extra.body as Body).fields).toEqual([
      { field: 'invoiceId', code: 'FIELD_NOT_ALLOWED' },
    ]);
    await e
      .decide(manager(), one.id, {
        decision: 'reject',
        reasonCode: 'outside_policy',
      })
      .expect(201);
  });

  it('race: two decisions on one compensation, one wins', async () => {
    const caseId = await caseFor();
    for (let round = 0; round < 5; round++) {
      const one = await e.propose(staff.token, caseId, { kind: 'priority' });
      const results = await Promise.all([
        e.decide(manager(), one.id, { decision: 'approve' }),
        e.decide(manager(), one.id, {
          decision: 'reject',
          reasonCode: 'already_compensated',
        }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const lost = results.find((r) => r.status === 409)!;
      expect((lost.body as Body).code).toBe('COMPENSATION_DECIDED');
      const audits = await e.inTx(s.c, (tx) =>
        tx.auditLog.count({
          where: {
            targetId: one.id,
            action: {
              in: [
                'experience_compensation.approved',
                'experience_compensation.rejected',
              ],
            },
          },
        }),
      );
      expect(audits).toBe(1);
    }
  });

  it('a credit within the limit: finance’s compensation credit note on the unit’s invoice, the unit told the code', async () => {
    const caseId = await caseFor();
    const credit = await e.propose(staff.token, caseId, {
      kind: 'credit',
      amount: '150.00',
    });
    const needs = await e
      .decide(manager(), credit.id, { decision: 'approve' })
      .expect(400);
    expect((needs.body as Body).fields).toEqual([
      { field: 'invoiceId', code: 'FIELD_REQUIRED' },
    ]);
    // Another unit's invoice is not found.
    const foreign = await e.invoice(s.c, o(5).unitId);
    const wrong = await e
      .decide(manager(), credit.id, { decision: 'approve', invoiceId: foreign })
      .expect(404);
    expect((wrong.body as Body).code).toBe('INVOICE_NOT_FOUND');
    const invoiceId = await e.invoice(s.c, o(4).unitId);
    const res = await e
      .decide(manager(), credit.id, { decision: 'approve', invoiceId })
      .expect(201);
    const body = res.body as CompensationBody;
    expect(body).toMatchObject({ status: 'approved', authorizationId: null });
    const note = await e.inTx(s.c, (tx) =>
      tx.creditNote.findUniqueOrThrow({ where: { id: body.creditNoteId! } }),
    );
    expect(note).toMatchObject({
      invoiceId,
      reasonCode: 'compensation',
      compensationReason: 'maintenance_delay',
    });
    expect(note.amount.toFixed(2)).toBe('150.00');
    expect(
      (await e.notifications(s.c, o(4).id, 'compensation.granted')).at(-1),
    ).toMatchObject({
      targetId: invoiceId,
      params: { reason: 'maintenance_delay' },
    });
    const audit = await e.inTx(s.c, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: 'credit_note.created', targetId: note.id },
      }),
    );
    expect(audit.metadata).toMatchObject({ compensationId: credit.id });
  });

  it('the threshold binds by default; above it the credit waits for the board, and what it approved serves one compensation', async () => {
    const read = await e
      .http('get', '/staff/governance/settings', manager())
      .expect(200);
    expect(
      (read.body as { items: { type: string }[] }).items.find(
        (r) => r.type === 'compensation_above_limit',
      ),
    ).toMatchObject({ binding: true, bindable: true, threshold: null });
    await e
      .http('patch', '/staff/governance/settings', manager(), {
        items: [{ type: 'compensation_above_limit', threshold: '500.00' }],
      })
      .expect(200);
    const caseId = await caseFor();
    const big = await e.propose(staff.token, caseId, {
      kind: 'credit',
      amount: '800.00',
    });
    expect(big.authority).toEqual({
      threshold: '500.00',
      binding: true,
      decider: 'board',
    });
    const inbox = await e
      .http('get', '/staff/inbox?type=compensation', manager())
      .expect(200);
    expect(
      (
        inbox.body as {
          data: { id: string; authority: { decider: string } | null }[];
        }
      ).data.find((r) => r.id === big.id)?.authority,
    ).toMatchObject({ decider: 'board' });
    const invoiceId = await e.invoice(s.c, o(4).unitId, '2000.00');
    const refused = await e
      .decide(manager(), big.id, { decision: 'approve', invoiceId })
      .expect(409);
    expect(refused.body).toMatchObject({
      code: 'NEEDS_BOARD_APPROVAL',
      params: { type: 'compensation_above_limit', limit: '500.00' },
    });
    // Nothing was paid, and it still waits.
    expect(
      (await e.api('get', `/compensations/${big.id}`, manager()).expect(200))
        .body,
    ).toMatchObject({ status: 'proposed', creditNoteId: null });
    const authorizationId = await approvedByBoard('800.00');
    const paid = await e
      .decide(manager(), big.id, {
        decision: 'approve',
        invoiceId,
        authorizationId,
      })
      .expect(201);
    expect(paid.body).toMatchObject({ status: 'approved', authorizationId });
    // Used once: another compensation above the limit cannot name it.
    const second = await e.propose(staff.token, caseId, {
      kind: 'credit',
      amount: '700.00',
    });
    const used = await e
      .decide(manager(), second.id, {
        decision: 'approve',
        invoiceId,
        authorizationId,
      })
      .expect(409);
    expect((used.body as Body).code).toBe('BOARD_AUTHORIZATION_USED');
    // Within the limit, an authorization is not taken.
    const small = await e.propose(staff.token, caseId, {
      kind: 'credit',
      amount: '100.00',
    });
    const extra = await e
      .decide(manager(), small.id, {
        decision: 'approve',
        invoiceId,
        authorizationId,
      })
      .expect(400);
    expect((extra.body as Body).fields).toEqual([
      { field: 'authorizationId', code: 'FIELD_NOT_ALLOWED' },
    ]);
    for (const id of [second.id, small.id])
      await e
        .decide(manager(), id, {
          decision: 'reject',
          reasonCode: 'other',
        })
        .expect(201);
  });

  it('a case does not close while a compensation waits; race: a proposal and a close at once', async () => {
    const caseId = await caseFor(o(3));
    const waiting = await e.propose(staff.token, caseId, { kind: 'apology' });
    const refused = await e
      .api('post', `/cases/${caseId}/close`, manager(), { outcome: 'resolved' })
      .expect(409);
    expect((refused.body as Body).code).toBe(
      'EXPERIENCE_CASE_COMPENSATION_PENDING',
    );
    await e.decide(manager(), waiting.id, { decision: 'approve' }).expect(201);
    const [proposal, close] = await Promise.all([
      e.api('post', `/cases/${caseId}/compensations`, staff.token, {
        kind: 'redo',
        failureCode: 'other',
      }),
      e.api('post', `/cases/${caseId}/close`, manager(), {
        outcome: 'compensated',
      }),
    ]);
    // Either the close went first (the proposal finds it closed), or the
    // proposal did (the close finds it waiting).
    const outcomes = [proposal.status, close.status].sort();
    expect(outcomes).toEqual([201, 409]);
    if (close.status === 409)
      expect((close.body as Body).code).toBe(
        'EXPERIENCE_CASE_COMPENSATION_PENDING',
      );
    else expect((proposal.body as Body).code).toBe('EXPERIENCE_CASE_CLOSED');
  });

  it('the rules recommend a kind and an amount per failure, set and removed, audited by code', async () => {
    const set = await e
      .api('put', '/compensation-rules', manager(), {
        items: [
          { failureCode: 'service_outage', kind: 'credit', amount: '75.00' },
          { failureCode: 'maintenance_delay', kind: 'apology' },
        ],
      })
      .expect(200);
    expect((set.body as { data: object[] }).data).toEqual([
      { failureCode: 'maintenance_delay', kind: 'apology', amount: null },
      { failureCode: 'service_outage', kind: 'credit', amount: '75.00' },
    ]);
    const bad = await e
      .api('put', '/compensation-rules', manager(), {
        items: [
          { failureCode: 'service_outage', kind: 'credit' },
          { failureCode: 'nope', kind: 'apology', amount: '5.00' },
        ],
      })
      .expect(400);
    expect((bad.body as Body).fields).toEqual([
      { field: 'items[0].amount', code: 'FIELD_REQUIRED' },
      {
        field: 'items[1].failureCode',
        code: 'INVALID_REASON_CODE',
        params: {
          allowed: [
            'service_outage',
            'maintenance_delay',
            'facility_closure',
            'other',
          ],
        },
      },
      { field: 'items[1].amount', code: 'FIELD_NOT_ALLOWED' },
    ]);
    await e
      .api('put', '/compensation-rules', manager(), {
        items: [{ failureCode: 'maintenance_delay', kind: null }],
      })
      .expect(200);
    const audit = await e.inTx(s.c, (tx) =>
      tx.auditLog.findFirstOrThrow({
        where: { action: 'experience.compensation_rules_changed' },
        orderBy: { occurredAt: 'desc' },
      }),
    );
    expect(audit.changes).toEqual({
      'maintenance_delay.kind': { from: 'apology', to: null },
    });
  });
});
