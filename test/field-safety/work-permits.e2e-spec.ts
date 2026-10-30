import { newId } from '../../src/core/common/uuid';
import { err } from '../api/request';
import {
  fieldSafetyHelpers,
  hoursFromNow,
  type FieldSafetySetUp,
  type PermitRead,
} from '../setup/field-safety';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0067: the hazards a ticket category or an asset type needs a work
 * permit for; the technician asks for one on their own ticket; who keeps
 * field safety approves, rejects or revokes it, once; the work starts, or
 * resumes, only with an approved permit in force for every hazard, checked
 * under the ticket's lock; completing the work closes the cycle's permits.
 */
describe('Field safety — work permits', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof fieldSafetyHelpers>;
  let s: FieldSafetySetUp;
  let heights: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = fieldSafetyHelpers(h);
    s = await f.setUp(2);
    heights = await f.category(s, ['height']);
  }, 90_000);

  afterAll(() => h.close());

  const permitRow = (id: string) =>
    f.inTenant(s.c, (tx) => tx.workPermit.findUniqueOrThrow({ where: { id } }));
  const notices = (kind: string, targetId: string) =>
    f.inTenant(s.c, (tx) =>
      tx.notification.findMany({ where: { kind, targetId } }),
    );

  it('the work does not start without an approved permit for its hazard; asked for, decided, then it starts', async () => {
    const id = await f.assigned(s, heights);
    expect(err(await f.step(s, id, 'start').expect(409))).toMatchObject({
      code: 'WORK_PERMIT_REQUIRED',
      params: { hazards: ['height'] },
    });
    const p = await f.permit(s, id);
    expect(p).toMatchObject({
      hazard: 'height',
      status: 'requested',
      cycle: 1,
    });
    const asked = await notices('work_permit.requested', id);
    expect(asked.map((n) => n.accountId)).toEqual(
      expect.arrayContaining([s.supervisor.id, s.manager.id]),
    );
    expect(asked[0].params).toMatchObject({ hazard: 'height' });
    expect(JSON.stringify(asked)).not.toContain('Harness');
    // Asked for is not approved.
    await f.step(s, id, 'start').expect(409);
    expect((await f.decide(s, p.id, 'approve').expect(200)).body).toMatchObject(
      {
        status: 'approved',
      },
    );
    expect(
      (await notices('work_permit.approved', id)).map((n) => n.accountId),
    ).toEqual([f.tech(s).id]);
    await f.step(s, id, 'start').expect(204);
  });

  it('needs a permit for its category’s hazards and its asset type’s, each listed', async () => {
    const typeId = await f.typeId(s, 'pump');
    await f
      .http(
        'put',
        `/maintenance/asset-types/${typeId}/permit-hazards`,
        s.supervisor.token,
        { hazards: ['live_electrical', 'height'] },
      )
      .expect(200);
    const pump = await f.asset(s, { typeId });
    const id = await f.workOrder(
      s,
      pump,
      await f.category(s, ['confined_space']),
    );
    expect(err(await f.step(s, id, 'start').expect(409)).params).toEqual({
      hazards: ['height', 'live_electrical', 'confined_space'],
    });
    await f.approved(s, id, 'height');
    await f.approved(s, id, 'live_electrical');
    expect(err(await f.step(s, id, 'start').expect(409)).params).toEqual({
      hazards: ['confined_space'],
    });
    await f.approved(s, id, 'confined_space');
    await f.step(s, id, 'start').expect(204);
    await f
      .http(
        'put',
        `/maintenance/asset-types/${typeId}/permit-hazards`,
        s.supervisor.token,
        { hazards: [] },
      )
      .expect(200);
  });

  it('expires within a day; one that has expired neither is approved nor lets the work start', async () => {
    const id = await f.assigned(s, heights);
    for (const expiresAt of [hoursFromNow(-1), hoursFromNow(25)])
      expect(
        err(
          await f
            .request(s, id, { expiresAt: expiresAt.toISOString() })
            .expect(400),
        ).fields,
      ).toEqual([
        { field: 'expiresAt', code: 'INVALID_VALUE', params: { maxHours: 24 } },
      ]);
    const raw = (status: 'requested' | 'approved') =>
      f.inTenant(s.c, async (tx) => {
        const ticket = await tx.ticket.findUniqueOrThrow({ where: { id } });
        return (
          await tx.workPermit.create({
            data: {
              id: newId(),
              tenantId: s.c.tenantId,
              ticketId: id,
              cycle: ticket.cycle,
              hazard: 'height',
              precautions: 'Old',
              requestedAt: hoursFromNow(-3),
              expiresAt: hoursFromNow(-1),
              requestedById: f.tech(s).id,
              status,
              ...(status === 'approved'
                ? { decidedAt: hoursFromNow(-2), decidedById: s.supervisor.id }
                : {}),
            },
          })
        ).id;
      });
    const stale = await raw('requested');
    expect(err(await f.decide(s, stale, 'approve').expect(409)).code).toBe(
      'WORK_PERMIT_EXPIRED',
    );
    await f.decide(s, stale, 'reject', 'not_needed').expect(200);
    await raw('approved');
    expect(err(await f.step(s, id, 'start').expect(409)).code).toBe(
      'WORK_PERMIT_REQUIRED',
    );
  });

  it('one open per hazard and cycle; rejected with a reason, another may be asked for', async () => {
    const id = await f.assigned(s, heights);
    const p = await f.permit(s, id);
    expect(err(await f.request(s, id).expect(409))).toMatchObject({
      code: 'WORK_PERMIT_OPEN',
      params: { permitId: p.id },
    });
    expect(
      err(await f.decide(s, p.id, 'reject', 'bored').expect(400)).fields?.[0],
    ).toMatchObject({ field: 'reasonCode', code: 'INVALID_REASON_CODE' });
    expect(
      (
        await f
          .decide(s, p.id, 'reject', 'precautions_insufficient')
          .expect(200)
      ).body,
    ).toMatchObject({
      status: 'rejected',
      rejectReason: 'precautions_insufficient',
    });
    expect(err(await f.decide(s, p.id, 'approve').expect(409))).toMatchObject({
      code: 'WORK_PERMIT_DECIDED',
      params: { status: 'rejected' },
    });
    await f.permit(s, id);
  });

  it('revoked once, an approved one only; work under way stays, but does not resume after a hold', async () => {
    const id = await f.assigned(s, heights);
    const asked = await f.permit(s, id);
    expect(
      err(await f.decide(s, asked.id, 'revoke', 'other').expect(409)).params,
    ).toEqual({
      status: 'requested',
    });
    await f.decide(s, asked.id, 'approve').expect(200);
    await f.step(s, id, 'start').expect(204);
    expect(
      (await f.decide(s, asked.id, 'revoke', 'unsafe_conditions').expect(200))
        .body,
    ).toMatchObject({ status: 'revoked', revokeReason: 'unsafe_conditions' });
    expect(
      (await notices('work_permit.revoked', id)).map((n) => n.accountId),
    ).toEqual([f.tech(s).id]);
    const row = await f.inTenant(s.c, (tx) =>
      tx.ticket.findUniqueOrThrow({ where: { id } }),
    );
    expect(row.status).toBe('in_progress');
    await f.step(s, id, 'hold', { holdReason: 'awaiting_parts' }).expect(204);
    expect(err(await f.step(s, id, 'resume').expect(409)).code).toBe(
      'WORK_PERMIT_REQUIRED',
    );
    await f.approved(s, id);
    await f.step(s, id, 'resume').expect(204);
  });

  it('completing the work closes the cycle’s open permits', async () => {
    const id = await f.assigned(s, heights);
    const p = await f.approved(s, id);
    const other = await f.permit(s, id, { hazard: 'hot_work' });
    await f.step(s, id, 'start').expect(204);
    await f.step(s, id, 'complete').expect(204);
    for (const permitId of [p.id, other.id])
      expect(await permitRow(permitId)).toMatchObject({ status: 'closed' });
    expect(err(await f.request(s, id).expect(409))).toMatchObject({
      code: 'WORK_PERMIT_TICKET_STATUS',
      params: { status: 'completed' },
    });
  });

  it('is the technician’s own ticket; who decides sees every permit and a ticket’s panel', async () => {
    const id = await f.assigned(s, heights);
    expect(err(await f.request(s, id, {}, 1).expect(404)).code).toBe(
      'TICKET_NOT_FOUND',
    );
    const p = await f.permit(s, id);
    const panel = (
      await f
        .http('get', `/maintenance/tickets/${id}/permits`, s.supervisor.token)
        .expect(200)
    ).body as { hazards: string[]; permits: PermitRead[] };
    expect(panel.hazards).toEqual(['height']);
    expect(panel.permits.map((x) => x.id)).toEqual([p.id]);
    const listed = (
      (
        await f
          .http(
            'get',
            `/maintenance/work-permits?status=requested&ticketId=${id}`,
            s.manager.token,
          )
          .expect(200)
      ).body as { data: PermitRead[] }
    ).data;
    expect(listed.map((x) => x.id)).toEqual([p.id]);
    await f
      .http('get', `/maintenance/work-permits/${p.id}`, f.tech(s).token)
      .expect(403);
  });

  describe('races', () => {
    it('an approval racing a rejection leaves one decision', async () => {
      for (let round = 0; round < 3; round++) {
        const id = await f.assigned(s, heights);
        const p = await f.permit(s, id);
        const results = await Promise.all([
          f.decide(s, p.id, 'approve'),
          f.decide(s, p.id, 'reject', 'not_needed'),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect(err(results.find((r) => r.status === 409)!).code).toBe(
          'WORK_PERMIT_DECIDED',
        );
        const row = await permitRow(p.id);
        expect(['approved', 'rejected']).toContain(row.status);
      }
    });

    it('a start racing a revocation: the start is refused, or the revocation follows it', async () => {
      for (let round = 0; round < 3; round++) {
        const id = await f.assigned(s, heights);
        const p = await f.approved(s, id);
        const [started, revoked] = await Promise.all([
          f.step(s, id, 'start'),
          f.decide(s, p.id, 'revoke', 'scope_changed'),
        ]);
        expect(revoked.status).toBe(200);
        const ticket = await f.inTenant(s.c, (tx) =>
          tx.ticket.findUniqueOrThrow({ where: { id } }),
        );
        if (started.status === 204) expect(ticket.status).toBe('in_progress');
        else {
          expect(started.status).toBe(409);
          expect(err(started).code).toBe('WORK_PERMIT_REQUIRED');
          expect(ticket.status).toBe('assigned');
        }
        expect((await permitRow(p.id)).status).toBe('revoked');
      }
    });
  });
});
