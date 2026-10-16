import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityHelpers, type ShiftBody, type Who } from '../setup/security';

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});

interface HandoverBody {
  id: string;
  shiftId: string;
  guard: { id: string; firstName?: string | null; fullName?: string | null };
  kind: 'guard' | 'system';
  checklist: { itemId: string; label: string }[];
  notes: string | null;
  acknowledgedAt: string | null;
  acknowledgedBy: { id: string } | null;
}

/**
 * ADR 0050: ending a shift, the guard ticks every active item of the
 * compound's checklist and may leave notes; the next guard at that post
 * acknowledges the handover, once. A shift the system ends leaves a
 * `system` handover. The management keeps the checklist and reads them all.
 */
describe('The handover', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityHelpers(h);
  }, 120_000);

  afterAll(() => h.close());

  const item = async (as: Who, label: string) =>
    (
      (
        await x
          .http('post', '/staff/security/handover-items', as.token, { label })
          .expect(201)
      ).body as { id: string }
    ).id;
  const pending = async (as: Who) =>
    (
      (await x.http('get', '/gate/handovers/pending', as.token).expect(200))
        .body as { data: HandoverBody[] }
    ).data;

  it('without a checklist: notes alone, or nothing; the next guard acknowledges once', async () => {
    const s = await x.setUp('Handover Plain Court');
    const gateId = (await x.g.gate(s.c)).id;
    const one = await x.guard(s.c);
    const two = await x.guard(s.c);
    const three = await x.guard(s.c);
    const first: ShiftBody = await x.start(one, { gateId });
    await x
      .endRaw(one, { notes: '  The barrier sticks; push twice.  ' })
      .expect(200);
    const second = await x.start(two, { gateId });
    expect(second.pendingHandovers).toBe(1);
    const [waiting] = await pending(two);
    expect(waiting).toMatchObject({
      shiftId: first.id,
      guard: { id: one.id, firstName: expect.any(String) as string },
      kind: 'guard',
      checklist: [],
      notes: 'The barrier sticks; push twice.',
      acknowledgedAt: null,
    });
    expect(Object.keys(waiting.guard)).not.toContain('fullName');

    // Elsewhere it is not found; one's own is refused.
    await x.start(three, { gateId: (await x.g.gate(s.c)).id });
    expect(
      code(
        await x.http(
          'post',
          `/gate/handovers/${waiting.id}/acknowledge`,
          three.token,
        ),
      ),
    ).toEqual({ status: 404, code: 'HANDOVER_NOT_FOUND' });
    await x.start(one, { gateId });
    expect(
      code(
        await x.http(
          'post',
          `/gate/handovers/${waiting.id}/acknowledge`,
          one.token,
        ),
      ),
    ).toEqual({ status: 403, code: 'HANDOVER_OWN' });

    const acked = await x
      .http('post', `/gate/handovers/${waiting.id}/acknowledge`, two.token)
      .expect(200);
    expect(acked.body).toMatchObject({
      acknowledgedBy: { id: two.id },
      acknowledgedAt: expect.any(String) as string,
    });
    // `one` is on shift there again: nothing waits, and it is acknowledged.
    expect(await pending(one)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ id: waiting.id })]),
    );
    await x.endRaw(one).expect(200);
    expect(
      code(
        await x.http(
          'post',
          `/gate/handovers/${waiting.id}/acknowledge`,
          three.token,
        ),
      ),
    ).toEqual({ status: 404, code: 'HANDOVER_NOT_FOUND' });

    // An end with nothing at all: a guard handover, no notes.
    const nothing = await x.inTx(s.c, (tx) =>
      tx.guardHandover.findFirstOrThrow({
        where: { guardAccountId: one.id, notes: null },
      }),
    );
    expect(nothing).toMatchObject({ kind: 'guard', checklist: [] });
    const [entry] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'guard_handover.recorded',
      targetId: waiting.id,
    });
    expect(entry.metadata).toEqual({
      shiftId: first.id,
      kind: 'guard',
      items: 0,
      notes: true,
    });
  });

  it('every active item ticked, or the shift stays open; retired items are ignored; unknown ones refused', async () => {
    const s = await x.setUp('Handover Checklist Court');
    const supervisor = await x.supervisor(s.c);
    const gateId = (await x.g.gate(s.c)).id;
    const keys = await item(supervisor, 'Keys counted');
    const radio = await item(supervisor, 'Radio charged');
    const old = await item(supervisor, 'Old item');
    await x
      .http(
        'patch',
        `/staff/security/handover-items/${old}`,
        supervisor.token,
        {
          active: false,
        },
      )
      .expect(200);
    const guard = await x.guard(s.c);
    const listed = (
      await x.http('get', '/gate/handover-items', guard.token).expect(200)
    ).body as { data: { id: string; label: string }[] };
    expect(listed.data.map((i) => i.id)).toEqual(
      expect.arrayContaining([keys, radio]),
    );
    expect(listed.data.map((i) => i.id)).not.toContain(old);

    const shift = await x.start(guard, { gateId });
    const short = await x.endRaw(guard, { checklist: [keys] });
    expect(short.status).toBe(422);
    expect(short.body).toMatchObject({
      code: 'HANDOVER_CHECKLIST_INCOMPLETE',
      params: { missing: [radio] },
    });
    expect((await x.shiftRow(s.c, shift.id)).endedAt).toBeNull();
    const unknown = await x.endRaw(guard, {
      checklist: [keys, radio, '019a0000-0000-7000-8000-000000000000'],
    });
    expect(code(unknown)).toEqual({ status: 400, code: 'VALIDATION_FAILED' });

    await x.endRaw(guard, { checklist: [radio, keys, old] }).expect(200);
    const recorded = await x.inTx(s.c, (tx) =>
      tx.guardHandover.findFirstOrThrow({ where: { shiftId: shift.id } }),
    );
    expect(recorded.checklist).toEqual(
      expect.arrayContaining([
        { itemId: keys, label: 'Keys counted' },
        { itemId: radio, label: 'Radio charged' },
      ]),
    );
    expect(recorded.checklist).toHaveLength(2);

    // Renaming an item later changes nothing of what was ticked.
    await x
      .http(
        'patch',
        `/staff/security/handover-items/${keys}`,
        supervisor.token,
        {
          label: 'Keys and cards counted',
        },
      )
      .expect(200);
    const read = (
      await x
        .http(
          'get',
          `/staff/security/handovers/${recorded.id}`,
          supervisor.token,
        )
        .expect(200)
    ).body as HandoverBody;
    expect(read.checklist).toContainEqual({
      itemId: keys,
      label: 'Keys counted',
    });
    expect(read.guard).toEqual({
      id: guard.id,
      fullName: expect.any(String) as string,
    });
  });

  it('a shift the system ends leaves a system handover: no checklist, no notes', async () => {
    const s = await x.setUp('Handover System Court');
    const gate = await x.g.gate(s.c);
    const guard = await x.guard(s.c);
    const shift = await x.start(guard, { gateId: gate.id });
    await x
      .http('patch', `/gates/${gate.id}`, s.manager.token, {
        status: 'inactive',
      })
      .expect(200);
    const handover = await x.inTx(s.c, (tx) =>
      tx.guardHandover.findFirstOrThrow({ where: { shiftId: shift.id } }),
    );
    expect(handover).toMatchObject({
      kind: 'system',
      checklist: [],
      notes: null,
    });
  });

  it('the management lists them, pending or acknowledged', async () => {
    const s = await x.setUp('Handover List Court');
    const supervisor = await x.supervisor(s.c);
    const gateId = (await x.g.gate(s.c)).id;
    const one = await x.guard(s.c);
    await x.start(one, { gateId });
    await x.endRaw(one, { notes: 'All quiet' }).expect(200);
    const list = async (state: string) =>
      (
        (
          await x
            .http(
              'get',
              `/staff/security/handovers?state=${state}&gateId=${gateId}`,
              supervisor.token,
            )
            .expect(200)
        ).body as { data: HandoverBody[] }
      ).data;
    expect(await list('pending')).toHaveLength(1);
    expect(await list('acknowledged')).toHaveLength(0);
  });

  it('a checklist holds 30 active items at most; notes are 2000 characters at most', async () => {
    const s = await x.setUp('Handover Limits Court');
    const supervisor = await x.supervisor(s.c);
    for (let i = 0; i < 30; i++) await item(supervisor, `Item ${i}`);
    expect(
      code(
        await x.http(
          'post',
          '/staff/security/handover-items',
          supervisor.token,
          {
            label: 'One more',
          },
        ),
      ),
    ).toEqual({ status: 409, code: 'HANDOVER_CHECKLIST_FULL' });
    const guard = await x.guard(s.c);
    await x.start(guard, { gateId: (await x.g.gate(s.c)).id });
    const long = await x.endRaw(guard, { notes: 'x'.repeat(2001) }).expect(400);
    expect((long.body as { fields: unknown[] }).fields).toEqual([
      { field: 'notes', code: 'INVALID_LENGTH', params: { min: 0, max: 2000 } },
    ]);
  });
});
