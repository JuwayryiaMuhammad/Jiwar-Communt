import { SWAP_EXPIRY_SWEEP } from '../../src/gate/swaps/swaps.service';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers, type Who } from '../setup/security';

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});
const fields = (res: { body: unknown }) =>
  (res.body as { fields?: unknown[] }).fields;
const DAY = 24 * 60;

interface SwapBody {
  id: string;
  status: string;
  role?: string;
  requesterSlot: { id: string };
  colleagueSlot: { id: string } | null;
  closeReason: string | null;
}

/**
 * ADR 0050: a guard asks a colleague to take one of their slots, in
 * exchange for one of the colleague's or as a cover; the colleague accepts
 * or declines; the roster's keepers approve or reject, and approval gives
 * the slots their new guards. A slot is in one live swap at most; nobody is
 * left with overlapping slots; a swap expires when its slot starts first.
 */
describe('Shift swaps', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityHelpers>['setUp']>>;
  let supervisor: Who;
  let gateId: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
    s = await x.setUp('Swaps Court');
    supervisor = await x.supervisor(s.c);
    gateId = (await x.g.gate(s.c)).id;
  }, 120_000);

  afterAll(() => h.close());

  const ask = (as: Who, body: Record<string, unknown>) =>
    x.http('post', '/gate/swaps', as.token, body);
  const asked = async (as: Who, body: Record<string, unknown>) =>
    (await ask(as, body).expect(201)).body as SwapBody;
  const act = (as: Who, id: string, verb: string, body?: object) =>
    x.http('post', `/gate/swaps/${id}/${verb}`, as.token, body);
  const decide = (id: string, verb: string, body?: object) =>
    x.http(
      'post',
      `/staff/security/swaps/${id}/${verb}`,
      supervisor.token,
      body,
    );
  const told = async (accountId: string, id: string) =>
    (await x.notifications(s.c, accountId))
      .filter((n) => n.targetId === id)
      .map((n) => n.kind);

  it('an exchange: asked, accepted, approved; each slot has its new guard', async () => {
    const a = await x.guard(s.c);
    const b = await x.guard(s.c);
    const sa = await x.slot(supervisor, a.id, { gateId }, DAY);
    const sb = await x.slot(supervisor, b.id, { gateId }, 2 * DAY);
    const swap = await asked(a, {
      slotId: sa.id,
      colleagueId: b.id,
      colleagueSlotId: sb.id,
      reason: 'A family wedding',
    });
    expect(swap).toMatchObject({
      status: 'requested',
      role: 'requester',
      requesterSlot: { id: sa.id },
      colleagueSlot: { id: sb.id },
    });
    expect(await told(b.id, swap.id)).toEqual(['guard_swap.requested']);
    const seen = (
      await x.http('get', `/gate/swaps/${swap.id}`, b.token).expect(200)
    ).body as SwapBody;
    expect(seen.role).toBe('colleague');
    expect(code(await act(a, swap.id, 'accept'))).toEqual({
      status: 403,
      code: 'SWAP_ACTION_NOT_ALLOWED',
    });
    await act(b, swap.id, 'accept').expect(200);
    expect(await told(supervisor.id, swap.id)).toEqual(['guard_swap.accepted']);
    expect(await told(s.manager.id, swap.id)).toEqual(['guard_swap.accepted']);
    const approved = await decide(swap.id, 'approve').expect(200);
    expect(approved.body).toMatchObject({
      status: 'approved',
      decidedBy: { id: supervisor.id },
    });
    expect(await x.slotRow(s.c, sa.id)).toMatchObject({
      guardAccountId: b.id,
      swappedAt: expect.any(Date) as Date,
    });
    expect((await x.slotRow(s.c, sb.id)).guardAccountId).toBe(a.id);
    for (const g of [a, b])
      expect(await told(g.id, swap.id)).toContain('guard_swap.approved');
    const mine = (
      await x
        .http('get', '/gate/roster?from=' + sb.startsAt.slice(0, 10), a.token)
        .expect(200)
    ).body as { data: { id: string }[] };
    expect(mine.data.map((sl) => sl.id)).toContain(sb.id);
  });

  it('a cover: the colleague takes the slot, nothing in exchange', async () => {
    const a = await x.guard(s.c);
    const c = await x.guard(s.c);
    const sa = await x.slot(supervisor, a.id, { gateId }, 3 * DAY);
    const swap = await asked(a, { slotId: sa.id, colleagueId: c.id });
    expect(swap.colleagueSlot).toBeNull();
    await act(c, swap.id, 'accept').expect(200);
    await decide(swap.id, 'approve').expect(200);
    expect((await x.slotRow(s.c, sa.id)).guardAccountId).toBe(c.id);
  });

  it('declined, withdrawn, rejected: each final, each told', async () => {
    const a = await x.guard(s.c);
    const b = await x.guard(s.c);
    const s1 = await x.slot(supervisor, a.id, { gateId }, 4 * DAY);
    const one = await asked(a, { slotId: s1.id, colleagueId: b.id });
    await act(b, one.id, 'decline').expect(200);
    expect(await told(a.id, one.id)).toEqual(['guard_swap.declined']);
    expect(code(await act(b, one.id, 'accept'))).toEqual({
      status: 409,
      code: 'SWAP_CLOSED',
    });

    const two = await asked(a, { slotId: s1.id, colleagueId: b.id });
    expect(code(await act(b, two.id, 'withdraw'))).toEqual({
      status: 403,
      code: 'SWAP_ACTION_NOT_ALLOWED',
    });
    await act(a, two.id, 'withdraw').expect(200);

    const three = await asked(a, { slotId: s1.id, colleagueId: b.id });
    await act(b, three.id, 'accept').expect(200);
    const rejected = await decide(three.id, 'reject', {
      reasonCode: 'staffing',
    }).expect(200);
    expect(rejected.body).toMatchObject({
      status: 'rejected',
      rejectReason: 'staffing',
    });
    for (const g of [a, b])
      expect(await told(g.id, three.id)).toContain('guard_swap.rejected');
    expect((await x.slotRow(s.c, s1.id)).guardAccountId).toBe(a.id);
  });

  it('what may be asked: my own slot to come, an active colleague, slots in no other live swap, no overlap', async () => {
    const a = await x.guard(s.c);
    const b = await x.guard(s.c);
    const c = await x.guard(s.c);
    const sa = await x.slot(supervisor, a.id, { gateId }, 5 * DAY);
    const sb = await x.slot(supervisor, b.id, { gateId }, 6 * DAY);
    expect(fields(await ask(b, { slotId: sa.id, colleagueId: a.id }))).toEqual([
      { field: 'slotId', code: 'SLOT_NOT_SWAPPABLE' },
    ]);
    expect(fields(await ask(a, { slotId: sa.id, colleagueId: a.id }))).toEqual([
      { field: 'colleagueId', code: 'GUARD_NOT_ELIGIBLE' },
    ]);
    const technician = await x.staff(s.c, ['tickets.work']);
    expect(
      fields(await ask(a, { slotId: sa.id, colleagueId: technician.id })),
    ).toEqual([{ field: 'colleagueId', code: 'GUARD_NOT_ELIGIBLE' }]);
    expect(
      fields(
        await ask(a, {
          slotId: sa.id,
          colleagueId: c.id,
          colleagueSlotId: sb.id,
        }),
      ),
    ).toEqual([{ field: 'colleagueSlotId', code: 'SLOT_NOT_SWAPPABLE' }]);
    await asked(a, {
      slotId: sa.id,
      colleagueId: b.id,
      colleagueSlotId: sb.id,
    });
    expect(code(await ask(a, { slotId: sa.id, colleagueId: c.id }))).toEqual({
      status: 409,
      code: 'SWAP_SLOT_BUSY',
    });
    expect(code(await ask(b, { slotId: sb.id, colleagueId: c.id }))).toEqual({
      status: 409,
      code: 'SWAP_SLOT_BUSY',
    });
    // c is scheduled at the time of a's next slot: no cover.
    const sa2 = await x.slot(supervisor, a.id, { gateId }, 7 * DAY);
    await x.slot(supervisor, c.id, { gateId }, 7 * DAY + 60);
    expect(code(await ask(a, { slotId: sa2.id, colleagueId: c.id }))).toEqual({
      status: 409,
      code: 'ROSTER_OVERLAP',
    });
  });

  it('a slot cancelled cancels its live swap; the approval finds it closed', async () => {
    const a = await x.guard(s.c);
    const b = await x.guard(s.c);
    const sa = await x.slot(supervisor, a.id, { gateId }, 8 * DAY);
    const swap = await asked(a, { slotId: sa.id, colleagueId: b.id });
    await act(b, swap.id, 'accept').expect(200);
    await x
      .http(
        'post',
        `/staff/security/roster/slots/${sa.id}/cancel`,
        supervisor.token,
        {
          reasonCode: 'post_closed',
        },
      )
      .expect(200);
    const read = (
      await x.http('get', `/gate/swaps/${swap.id}`, a.token).expect(200)
    ).body as SwapBody;
    expect(read).toMatchObject({
      status: 'cancelled',
      closeReason: 'slot_cancelled',
    });
    for (const g of [a, b])
      expect(await told(g.id, swap.id)).toContain('guard_swap.cancelled');
    expect(code(await decide(swap.id, 'approve'))).toEqual({
      status: 409,
      code: 'SWAP_CLOSED',
    });
  });

  it('a slot that starts before a decision: the swap expires, once', async () => {
    const a = await x.guard(s.c);
    const b = await x.guard(s.c);
    const sa = await x.slot(supervisor, a.id, { gateId }, 45, 60);
    const swap = await asked(a, { slotId: sa.id, colleagueId: b.id });
    const later = new Date(Date.now() + 50 * 60_000);
    expect(await x.sweep(SWAP_EXPIRY_SWEEP, later)).toBeGreaterThanOrEqual(1);
    await x.sweep(SWAP_EXPIRY_SWEEP, later);
    const read = (
      await x.http('get', `/gate/swaps/${swap.id}`, a.token).expect(200)
    ).body as SwapBody;
    expect(read.status).toBe('expired');
    expect(await told(b.id, swap.id)).toEqual([
      'guard_swap.requested',
      'guard_swap.expired',
    ]);
  });

  it('nobody decides their own swap; outsiders see none', async () => {
    const both = await x.staff(s.c, ['gate.operate', 'guard_roster.manage']);
    const b = await x.guard(s.c);
    const sa = await x.slot(supervisor, both.id, { gateId }, 9 * DAY);
    const swap = await asked(both, { slotId: sa.id, colleagueId: b.id });
    await act(b, swap.id, 'accept').expect(200);
    expect(
      code(
        await x.http(
          'post',
          `/staff/security/swaps/${swap.id}/approve`,
          both.token,
        ),
      ),
    ).toEqual({ status: 403, code: 'SWAP_ACTION_NOT_ALLOWED' });
    const outsider = await x.guard(s.c);
    expect(
      code(await x.http('get', `/gate/swaps/${swap.id}`, outsider.token)),
    ).toEqual({
      status: 404,
      code: 'SWAP_NOT_FOUND',
    });
  });
});
