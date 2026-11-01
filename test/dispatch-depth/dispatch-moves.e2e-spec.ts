import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { TicketsService } from '../../src/maintenance/tickets/tickets.service';
import { communityHelpers } from '../setup/community';

/** An answer's body, as the assertions read it. */
type Body = {
  code: string;
  fields: { field: string; code: string }[];
  [key: string]: unknown;
};

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

/**
 * ADR 0076: dispatch's own moves on a ticket. It closes a resident's
 * completed ticket on their behalf (`closed_by_staff`, a reason code, the
 * residents told and still able to reopen), reopens a closed ticket within
 * 30 days (the residents' reopen path, the residents told), and resumes a
 * ticket on hold in its technician's hands. Each under the ticket's lock,
 * audited, and never the technician's or the resident's to call.
 */
describe('Dispatch depth — dispatch closes, reopens and resumes', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
  }, 180_000);

  afterAll(() => h.close());

  const tech = (id: string, verb: string, body?: object) =>
    d.http('post', `/technician/tickets/${id}/${verb}`, s.techs[0].token, body);

  const dispatch = (
    id: string,
    verb: string,
    body?: object,
    token = s.supervisor.token,
  ) => d.http('post', `/maintenance/tickets/${id}/${verb}`, token, body);

  async function started(): Promise<string> {
    const id = await d.openTicket(s);
    await dispatch(id, 'assign', { technicianId: s.techs[0].id }).expect(204);
    await tech(id, 'start').expect(204);
    return id;
  }

  async function completed(): Promise<string> {
    const id = await started();
    await tech(id, 'complete', {}).expect(204);
    return id;
  }

  const row = (id: string) => d.ticketRow(s.c, id);

  const notices = (accountId: string, ticketId: string) =>
    d.inTenant(s.c, (tx) =>
      tx.notification.findMany({
        where: { accountId, targetId: ticketId },
        orderBy: { createdAt: 'asc' },
        select: { kind: true, params: true },
      }),
    );

  const audits = (action: string, ticketId: string) =>
    d.inTenant(s.c, (tx) =>
      tx.auditLog.findMany({ where: { action, targetId: ticketId } }),
    );

  // --- close ---------------------------------------------------------------

  it('closes a resident’s completed ticket for them: closed by the staff, the code in its history, the residents told', async () => {
    const id = await completed();
    await dispatch(id, 'close', { reasonCode: 'confirmed_by_phone' }).expect(
      204,
    );
    expect(await row(id)).toMatchObject({
      status: 'closed',
      confirmationStatus: 'closed_by_staff',
    });
    const last = await d.inTenant(s.c, (tx) =>
      tx.ticketStatusHistory.findFirstOrThrow({
        where: { ticketId: id },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(last).toMatchObject({
      fromStatus: 'completed',
      toStatus: 'closed',
      actorId: s.supervisor.id,
      reasonCode: 'confirmed_by_phone',
    });
    expect((await notices(s.owner.id, id)).map((n) => n.kind)).toContain(
      'ticket.closed_by_staff',
    );
    const [audit] = await audits('ticket.closed_by_staff', id);
    expect(audit.metadata).toMatchObject({
      reasonCode: 'confirmed_by_phone',
      cycle: 1,
    });
    // The residents may still reopen it in their window.
    await d
      .http('post', `/tickets/${id}/reopen`, s.owner.token, {
        reasonCode: 'problem_returned',
        reason: 'It leaks again',
      })
      .expect(204);
  });

  it('closes only a completed resident ticket, with a code from its list', async () => {
    const working = await started();
    await dispatch(working, 'close', { reasonCode: 'resident_left' })
      .expect(409)
      .expect((r) =>
        expect((r.body as Body).code).toBe('TICKET_INVALID_TRANSITION'),
      );
    const id = await completed();
    await dispatch(id, 'close', {})
      .expect(400)
      .expect((r) => expect((r.body as Body).code).toBe('REASON_REQUIRED'));
    await dispatch(id, 'close', { reasonCode: 'bored' })
      .expect(400)
      .expect((r) =>
        expect((r.body as Body).fields[0]).toMatchObject({
          field: 'reasonCode',
          code: 'INVALID_REASON_CODE',
        }),
      );
  });

  it('a work order of the compound’s is accepted, not closed for residents', async () => {
    const x = communityHelpers(h);
    const categoryId = await d.categoryId(s.c, 'plumbing');
    const area = await d
      .http('post', '/maintenance/areas', s.manager.token, {
        kind: 'area',
        code: `A-${Date.now()}`,
        nameAr: 'ممر',
        nameEn: 'Corridor',
      })
      .expect(201);
    const wo = await x.asManager(s.c, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        h.moduleRef.get(TicketsService).createWorkOrder(tx, {
          tenantId: s.c.tenantId,
          origin: 'staff',
          commonAreaId: (area.body as { id: string }).id,
          categoryId,
          priority: 'normal',
          description: 'Light out',
          responsibleId: s.supervisor.id,
          actorId: s.supervisor.id,
        }),
      ),
    );
    await dispatch(wo.id, 'assign', { technicianId: s.techs[0].id }).expect(
      204,
    );
    await tech(wo.id, 'start').expect(204);
    await tech(wo.id, 'complete', {}).expect(204);
    await dispatch(wo.id, 'close', { reasonCode: 'other' })
      .expect(409)
      .expect((r) =>
        expect((r.body as Body).code).toBe('TICKET_NOT_RESIDENTS'),
      );
  });

  // --- reopen --------------------------------------------------------------

  it('reopens a closed ticket: a new cycle back to its technician, the words in the thread, the residents told', async () => {
    const id = await completed();
    await d
      .http('post', `/tickets/${id}/confirm`, s.owner.token, { rating: 5 })
      .expect(204);
    await dispatch(id, 'reopen', {
      reasonCode: 'problem_returned',
      reason: 'The owner called: it drips again',
    }).expect(204);
    expect(await row(id)).toMatchObject({
      status: 'assigned',
      technicianId: s.techs[0].id,
      cycle: 2,
      confirmationStatus: 'rejected',
      closedAt: null,
    });
    const thread = await d.inTenant(s.c, (tx) =>
      tx.ticketMessage.findMany({ where: { ticketId: id } }),
    );
    expect(thread.map((m) => m.body)).toContain(
      'The owner called: it drips again',
    );
    expect(
      (await notices(s.owner.id, id)).filter(
        (n) => n.kind === 'ticket.status_changed',
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({ status: 'assigned' }) as unknown,
        }),
      ]),
    );
    const [audit] = await audits('ticket.reopened_by_staff', id);
    expect(audit.metadata).toMatchObject({
      reasonCode: 'problem_returned',
      cycle: 2,
    });
    expect(JSON.stringify(audit)).not.toContain('drips');
  });

  it('reopens only within 30 days of closing, and only a closed ticket', async () => {
    const open = await started();
    await dispatch(open, 'reopen', {
      reasonCode: 'not_fixed',
      reason: 'x',
    }).expect(409);
    const id = await completed();
    await dispatch(id, 'close', { reasonCode: 'resident_unreachable' }).expect(
      204,
    );
    await d.inTenant(
      s.c,
      (tx) =>
        tx.$executeRaw`UPDATE tickets SET closed_at = closed_at - interval '31 days' WHERE id = ${id}::uuid`,
    );
    const late = await dispatch(id, 'reopen', {
      reasonCode: 'not_fixed',
      reason: 'Still broken',
    }).expect(409);
    expect(late.body).toMatchObject({
      code: 'TICKET_REOPEN_WINDOW_PASSED',
      params: { reopenDays: 30 },
    });
  });

  // --- resume --------------------------------------------------------------

  it('resumes a ticket on hold in its technician’s hands; they are told', async () => {
    const id = await started();
    await tech(id, 'hold', { holdReason: 'awaiting_parts' }).expect(204);
    await dispatch(id, 'resume').expect(204);
    expect(await row(id)).toMatchObject({
      status: 'in_progress',
      holdReason: null,
      technicianId: s.techs[0].id,
    });
    expect(
      (await notices(s.techs[0].id, id)).some(
        (n) =>
          n.kind === 'ticket.status_changed' &&
          (n.params as { status?: string }).status === 'in_progress',
      ),
    ).toBe(true);
    expect(await audits('ticket.resumed_by_staff', id)).toHaveLength(1);
    await dispatch(id, 'resume')
      .expect(409)
      .expect((r) =>
        expect((r.body as Body).code).toBe('TICKET_INVALID_TRANSITION'),
      );
  });

  it('is dispatch’s alone', async () => {
    const id = await completed();
    await dispatch(
      id,
      'close',
      { reasonCode: 'other' },
      s.techs[0].token,
    ).expect(403);
    await dispatch(id, 'close', { reasonCode: 'other' }, s.owner.token).expect(
      403,
    );
  });

  it('race: dispatch closes while the resident confirms; exactly one wins', async () => {
    for (let i = 0; i < 3; i++) {
      const id = await completed();
      const [close, confirm] = await Promise.all([
        dispatch(id, 'close', { reasonCode: 'confirmed_by_phone' }),
        d.http('post', `/tickets/${id}/confirm`, s.owner.token, { rating: 4 }),
      ]);
      expect([close.status, confirm.status].sort()).toEqual([204, 409]);
      const t = await row(id);
      expect(t.status).toBe('closed');
      expect(t.confirmationStatus).toBe(
        close.status === 204 ? 'closed_by_staff' : 'confirmed',
      );
    }
  });
});
