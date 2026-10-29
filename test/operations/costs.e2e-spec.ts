import { newId } from '../../src/core/common/uuid';
import { err } from '../api/request';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { operationsHelpers, type OperationsSetUp } from '../setup/operations';

interface Entry {
  id: string;
  kind: string;
  quantity: string;
  unitAmount: string;
  amount: string;
  voidedAt: string | null;
  voidReason: string | null;
}
interface Costs {
  data: Entry[];
  totals: Record<'total' | 'labour' | 'contractor' | 'parts' | 'other', string>;
}

/**
 * ADR 0065: what a job cost, recorded by dispatch, voided once; and what
 * the technician did as they completed it — a code the resident sees, a
 * note only the staff read.
 */
describe('Operations — a ticket’s costs and its completion', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof operationsHelpers>;
  let s: OperationsSetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = operationsHelpers(h);
    s = await o.setUp(1);
  }, 90_000);

  afterAll(() => h.close());

  const costs = async (id: string) =>
    (
      await o
        .http('get', `/maintenance/tickets/${id}/costs`, s.supervisor.token)
        .expect(200)
    ).body as Costs;
  const record = (id: string, body: object, key?: string) => {
    const req = o.http(
      'post',
      `/maintenance/tickets/${id}/costs`,
      s.supervisor.token,
      body,
    );
    return key ? req.set('Idempotency-Key', key) : req;
  };

  it('dispatch records labour, a contractor and other costs; the amounts are computed and summed', async () => {
    const id = await o.assignedTicket(s);
    const labour = (
      await record(id, {
        kind: 'labour',
        description: 'COST-secret two hours',
        quantity: '1.5',
        unitAmount: '10.25',
      }).expect(201)
    ).body as Entry;
    expect(labour).toMatchObject({
      kind: 'labour',
      quantity: '1.500',
      unitAmount: '10.25',
      amount: '15.38',
      voidedAt: null,
    });
    await record(id, {
      kind: 'contractor',
      description: 'Plumber',
      quantity: '1',
      unitAmount: '400',
    }).expect(201);
    const listed = await costs(id);
    expect(listed.data.map((e) => e.kind)).toEqual(['labour', 'contractor']);
    expect(listed.totals).toEqual({
      total: '415.38',
      labour: '15.38',
      contractor: '400.00',
      parts: '0.00',
      other: '0.00',
    });
    // The store's kind is not recorded by hand; technicians and residents
    // reach none of it.
    await record(id, {
      kind: 'part',
      description: 'x',
      quantity: '1',
      unitAmount: '1',
    }).expect(400);
    await o
      .http('get', `/maintenance/tickets/${id}/costs`, s.techs[0].token)
      .expect(403);
    await o
      .http('get', `/maintenance/tickets/${id}/costs`, s.owner.token)
      .expect(403);
  });

  it('a replayed record answers the same entry and writes nothing more', async () => {
    const id = await o.assignedTicket(s);
    const key = newId();
    const body = {
      kind: 'other',
      description: 'Scaffold rental',
      quantity: '1',
      unitAmount: '250',
    };
    const first = (await record(id, body, key).expect(201)).body as Entry;
    const again = (await record(id, body, key).expect(201)).body as Entry;
    expect(again.id).toBe(first.id);
    expect((await costs(id)).data).toHaveLength(1);
  });

  it('an entry is voided once, with a reason from the closed list; two voids at once leave one', async () => {
    const id = await o.assignedTicket(s);
    const entry = (
      await record(id, {
        kind: 'labour',
        description: 'Wrong ticket',
        quantity: '1',
        unitAmount: '100',
      }).expect(201)
    ).body as Entry;
    const voidIt = (reasonCode?: string) =>
      o.http(
        'post',
        `/maintenance/ticket-costs/${entry.id}/void`,
        s.manager.token,
        {
          ...(reasonCode ? { reasonCode } : {}),
        },
      );
    expect(err(await voidIt().expect(400)).code).toBe('REASON_REQUIRED');
    expect(err(await voidIt('typo').expect(400)).fields).toEqual([
      {
        field: 'reasonCode',
        code: 'INVALID_REASON_CODE',
        params: { allowed: ['entered_in_error', 'duplicate', 'other'] },
      },
    ]);
    const results = await Promise.all([
      voidIt('entered_in_error'),
      voidIt('duplicate'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(err(results.find((r) => r.status === 409)!).code).toBe(
      'TICKET_COST_ENTRY_VOIDED',
    );
    const listed = await costs(id);
    expect(listed.data[0].voidedAt).not.toBeNull();
    expect(listed.totals.total).toBe('0.00');
    // The database keeps the row as it was recorded.
    await expect(
      o.inTenant(s.c, (tx) =>
        tx.ticketCostEntry.update({
          where: { id: entry.id },
          data: { amount: '1.00' },
        }),
      ),
    ).rejects.toThrow(/voided once and never edited/);
  });

  it('a ticket holds two hundred entries at most, even recorded at once', async () => {
    const id = await o.assignedTicket(s);
    await o.inTenant(s.c, async (tx) => {
      for (let i = 0; i < 198; i++)
        await tx.ticketCostEntry.create({
          data: {
            id: newId(),
            tenantId: s.c.tenantId,
            ticketId: id,
            kind: 'other',
            description: `Fill ${i}`,
            quantity: '1',
            unitAmount: '1',
            amount: '1.00',
            enteredById: s.supervisor.id,
            enteredAt: new Date(),
          },
        });
    });
    const body = {
      kind: 'other',
      description: 'Race',
      quantity: '1',
      unitAmount: '1',
    };
    const results = await Promise.all([1, 2, 3].map(() => record(id, body)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409]);
    const refused = results.find((r) => r.status === 409)!;
    expect(err(refused)).toMatchObject({
      code: 'TICKET_COST_LIMIT_REACHED',
      params: { max: 200 },
    });
    expect((await costs(id)).data).toHaveLength(200);
  });

  describe('completion', () => {
    const complete = (id: string, body: object = {}) =>
      o.http(
        'post',
        `/technician/tickets/${id}/complete`,
        s.techs[0].token,
        body,
      );

    it('what was done: the technician and dispatch read the code and the note, the resident only the code', async () => {
      const id = await o.startedTicket(s);
      await complete(id, {
        actionCode: 'part_replaced',
        note: 'COMPLETION-secret valve swapped',
      }).expect(204);
      const tech = (
        await o
          .http('get', `/technician/tickets/${id}`, s.techs[0].token)
          .expect(200)
      ).body as { completion: { actionCode: string; note: string } };
      expect(tech.completion).toMatchObject({
        actionCode: 'part_replaced',
        note: 'COMPLETION-secret valve swapped',
      });
      const dispatch = (
        await o
          .http('get', `/maintenance/tickets/${id}`, s.supervisor.token)
          .expect(200)
      ).body as { completion: { completedAt: string } };
      const row = await o.ticketRow(s.c, id);
      expect(new Date(dispatch.completion.completedAt).getTime()).toBe(
        row.completedAt!.getTime(),
      );
      const resident = await o
        .http('get', `/tickets/${id}`, s.owner.token)
        .expect(200);
      expect(resident.body).toMatchObject({
        completionAction: 'part_replaced',
      });
      expect(JSON.stringify(resident.body)).not.toContain('COMPLETION-secret');
      // Recorded once and kept.
      await expect(
        o.inTenant(s.c, (tx) =>
          tx.ticketCompletion.updateMany({
            where: { ticketId: id },
            data: { note: 'x' },
          }),
        ),
      ).rejects.toThrow();
    });

    it('a note needs what was done; an unknown code is refused; nothing at all still completes', async () => {
      const id = await o.startedTicket(s);
      expect(
        err(await complete(id, { note: 'Only words' }).expect(400)).fields,
      ).toEqual([{ field: 'actionCode', code: 'FIELD_REQUIRED' }]);
      expect(
        err(await complete(id, { actionCode: 'fixed' }).expect(400)).fields,
      ).toEqual([
        expect.objectContaining({
          field: 'actionCode',
          code: 'INVALID_VALUE',
        }) as unknown,
      ]);
      expect((await o.ticketRow(s.c, id)).status).toBe('in_progress');
      await complete(id).expect(204);
      const tech = (
        await o
          .http('get', `/technician/tickets/${id}`, s.techs[0].token)
          .expect(200)
      ).body as { completion: unknown };
      expect(tech.completion).toBeNull();
    });
  });
});
