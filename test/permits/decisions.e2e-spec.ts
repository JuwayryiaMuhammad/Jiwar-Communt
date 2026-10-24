import { NOT_DECIDED_SWEEP } from '../../src/gate/permits/permit-sweeps';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { permitRow } from '../setup/permits-rows';
import { at, day, permitHelpers, type PermitBody } from '../setup/permits';

// eslint-disable-next-line no-restricted-syntax -- past instants only: approval is refused once endsAt <= now
const DAY = 86_400_000;

describe('Permits — the management decides (ADR 0049)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  it('approves: the requester is told; the household never sees the note', async () => {
    const c = await p.setUp('Decide Approve Court');
    const permit = await p.works(c.alice, c.home.id);
    const res = await p
      .decide(c.manager, permit.id, 'approve', { note: 'Staff-only words' })
      .expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      status: 'approved',
      decisionSource: 'manager',
      staffNote: 'Staff-only words',
      requestedBy: { id: c.alice.id },
    });
    expect(await p.told(c.c, c.alice.id, permit.id)).toEqual([
      { kind: 'unit_permit.approved', params: { permitKind: 'works' } },
    ]);
    const seen = await p.get(c.alice, permit.id);
    expect(seen).toMatchObject({ status: 'approved' });
    expect(JSON.stringify(seen)).not.toContain('Staff-only words');
    // Decided once.
    expect(
      (
        await p
          .decide(c.manager, permit.id, 'reject', { reasonCode: 'other' })
          .expect(409)
      ).body,
    ).toMatchObject({
      code: 'PERMIT_NOT_PENDING',
      params: { status: 'approved' },
    });
  });

  it('rejects with a reason code from the list; the requester is told the code', async () => {
    const c = await p.setUp('Decide Reject Court');
    const permit = await p.move(c.alice, c.home.id, {
      date: await p.workDay(c.alice, 5),
    });
    expect(
      (await p.decide(c.manager, permit.id, 'reject', {}).expect(400)).body,
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }],
    });
    expect(
      (
        await p
          .decide(c.manager, permit.id, 'reject', { reasonCode: 'mood' })
          .expect(400)
      ).body,
    ).toMatchObject({
      fields: [
        {
          field: 'reasonCode',
          code: 'INVALID_REASON_CODE',
          params: {
            allowed: [
              'missing_details',
              'outside_rules',
              'too_many_guests',
              'safety_concern',
              'other',
            ],
          },
        },
      ],
    });
    const done = (
      await p
        .decide(c.manager, permit.id, 'reject', { reasonCode: 'outside_rules' })
        .expect(200)
    ).body as PermitBody;
    expect(done).toMatchObject({
      status: 'rejected',
      rejectReason: 'outside_rules',
    });
    expect(await p.told(c.c, c.alice.id, permit.id)).toEqual([
      {
        kind: 'unit_permit.rejected',
        params: { permitKind: 'move', reason: 'outside_rules' },
      },
    ]);
  });

  it('revokes an approved permit in force; never a pending, an ended or a used one', async () => {
    const c = await p.setUp('Decide Revoke Court');
    const permit = await p.works(c.alice, c.home.id);
    expect(
      (
        await p
          .decide(c.manager, permit.id, 'revoke', { reasonCode: 'complaint' })
          .expect(409)
      ).body,
    ).toMatchObject({
      code: 'PERMIT_NOT_ACTIVE',
      params: { status: 'pending' },
    });
    await p.approve(c.manager, permit.id);
    const done = (
      await p
        .decide(c.manager, permit.id, 'revoke', {
          reasonCode: 'rules_broken',
          note: 'Noise after hours',
        })
        .expect(200)
    ).body as PermitBody;
    expect(done).toMatchObject({
      status: 'revoked',
      revokeReason: 'rules_broken',
      revokeNote: 'Noise after hours',
    });
    expect(await p.told(c.c, c.alice.id, permit.id)).toEqual([
      { kind: 'unit_permit.approved', params: { permitKind: 'works' } },
      {
        kind: 'unit_permit.revoked',
        params: { permitKind: 'works', reason: 'rules_broken' },
      },
    ]);
    // The household sees the code, not the note.
    const seen = await p.get(c.alice, permit.id);
    expect(seen).toMatchObject({ revokeReason: 'rules_broken' });
    expect(JSON.stringify(seen)).not.toContain('Noise after hours');
    // Cancelling a revoked permit: over.
    await p
      .http('post', `/permits/${permit.id}/cancel`, c.alice.token, {})
      .expect(409);
  });

  it('the queue and the live list; one permit with its workers’ faces', async () => {
    const c = await p.setUp('Decide Queue Court');
    await p.anyTime(c.manager);
    const pending = await p.works(c.alice, c.home.id);
    const { worker } = await p.addWorker(c.alice, pending.id);
    const live = await p.event(c.alice, c.home.id, 3, {
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const list = async (q: string) =>
      (
        (
          await p
            .http('get', `/staff/unit-permits?${q}`, c.manager.token)
            .expect(200)
        ).body as { data: PermitBody[] }
      ).data.map((x) => x.id);
    expect(await list('status=pending')).toEqual([pending.id]);
    expect(await list('live=true')).toEqual([live.id]);
    expect(await list(`kind=event&unitId=${c.home.id}`)).toEqual([live.id]);
    const detail = (
      await p
        .http('get', `/staff/unit-permits/${pending.id}`, c.manager.token)
        .expect(200)
    ).body as PermitBody;
    expect(detail.works!.workers).toEqual([
      expect.objectContaining({
        id: worker.id,
        photo: expect.objectContaining({
          url: expect.any(String) as string,
        }) as object,
      }),
    ]);
    expect(detail.requestedBy).toMatchObject({
      fullName: expect.any(String) as string,
    });
  });

  it('takes a worker off with a reason code, once', async () => {
    const c = await p.setUp('Decide Worker Court');
    const permit = await p.works(c.alice, c.home.id);
    const { worker } = await p.addWorker(c.alice, permit.id);
    const remove = (body: object) =>
      p.http(
        'post',
        `/staff/unit-permits/${permit.id}/workers/${worker.id}/remove`,
        c.manager.token,
        body,
      );
    expect((await remove({}).expect(400)).body).toMatchObject({
      code: 'VALIDATION_FAILED',
      fields: [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }],
    });
    const done = (await remove({ reasonCode: 'misconduct' }).expect(200))
      .body as PermitBody;
    expect(done.works!.workers[0]).toMatchObject({ removedBy: 'management' });
    await remove({ reasonCode: 'other' }).expect(200);
    const row = await p.v.inTx(c.c, (tx) =>
      tx.permitWorker.findUniqueOrThrow({ where: { id: worker.id } }),
    );
    expect(row).toMatchObject({
      removedSide: 'management',
      removeReason: 'misconduct',
      removedById: c.manager.id,
    });
  });

  it('nobody decided in time: works at their end, an event at its start, cancelled by the system and the requester told', async () => {
    const c = await p.setUp('Decide Sweep Court');
    await p.anyTime(c.manager);
    const works = await p.works(c.alice, c.home.id, {
      startsOn: day(1),
      endsOn: day(2),
    });
    const event = await p.event(c.alice, c.home.id, 25, {
      startsAt: at(day(1), 20).toISOString(),
      endsAt: at(day(2), 2).toISOString(),
    });
    const approved = await p.works(c.alice, c.home.id, {
      startsOn: day(1),
      endsOn: day(1),
    });
    await p.approve(c.manager, approved.id);
    const sweep = (now: Date) => p.sweep(NOT_DECIDED_SWEEP, now);
    // Before the event starts: nothing.
    await sweep(new Date(at(day(1), 19).getTime()));
    expect((await p.get(c.alice, event.id)).status).toBe('pending');
    // After it started: the event; the works only once ended.
    await sweep(new Date(at(day(1), 21).getTime()));
    expect((await p.get(c.alice, event.id)).status).toBe('cancelled');
    expect((await p.get(c.alice, works.id)).status).toBe('pending');
    await sweep(new Date(at(day(3), 1).getTime()));
    const done = await p.get(c.alice, works.id);
    expect(done).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'system',
      cancelReason: 'not_decided',
    });
    // An approved one is never the sweep's.
    expect((await p.get(c.alice, approved.id)).status).toBe('approved');
    expect(await p.told(c.c, c.alice.id, works.id)).toEqual([
      {
        kind: 'unit_permit.cancelled',
        params: { permitKind: 'works', reason: 'not_decided' },
      },
    ]);
    // An approval after its window, before the sweep came: refused.
    const late = await p.v.inTx(c.c, (tx) =>
      permitRow(tx, {
        tenantId: c.c.tenantId,
        unitId: c.home.id,
        requestedById: c.alice.id,
        data: {
          // eslint-disable-next-line test-clock/day-multiple -- past instants only: approval is refused once endsAt <= now
          startsAt: new Date(Date.now() - 2 * DAY),
          endsAt: new Date(Date.now() - DAY),
        },
      }),
    );
    expect(
      (await p.decide(c.manager, late, 'approve').expect(409)).body,
    ).toMatchObject({
      code: 'PERMIT_NOT_ACTIVE',
      params: { status: 'pending' },
    });
  });
});
