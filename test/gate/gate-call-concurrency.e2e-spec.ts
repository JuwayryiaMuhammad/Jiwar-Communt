import { randomUUID } from 'node:crypto';
import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import {
  FAKE_CALL_SIGNATURE_HEADER,
  signFakeCallEvent,
} from '../../src/gate/calls/fake-call-driver';
import { GATE_CALL_TIMEOUT_SWEEP } from '../../src/gate/calls/gate-calls.service';
import { communityHelpers } from '../setup/community';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers, type Who } from '../setup/security-ops';
import { whileShiftEnds } from '../setup/shift-end';

/**
 * ADR 0068, the gate calls' races. Two household members answer at once:
 * one takes it (the call's row lock). An answer against the ring's
 * timeout, or the guard's end: one of the two, and the call agrees with
 * what each was told. A call started while the shift ends is refused. The
 * vendor's same event twice at once is taken once.
 */
describe('Gate — calls from the gate (races)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let bob: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Gate Call Race Court');
    const cx = communityHelpers(h);
    const joined = await cx.joinFamily(s.c, s.home.id, s.alice);
    await cx.as(s.c, { id: s.alice.id, type: 'resident' }, () =>
      h.moduleRef
        .get(MemberPermissionsService)
        .grant(joined.memberId, 'visitors_invite'),
    );
    bob = await x.who(s.c, joined.accountId, 'family');
  }, 120_000);

  afterAll(() => h.close());

  const start = async (guard: Who) =>
    (
      await x
        .http('post', '/gate/calls', guard.token, {
          unitId: s.home.id,
          reasonCode: 'delivery_at_gate',
        })
        .expect(201)
    ).body as { id: string };
  const answer = (who: Who, id: string) =>
    x.http('post', `/me/gate-calls/${id}/answer`, who.token);
  const row = (id: string) =>
    x.inTx(s.c, (tx) => tx.gateCall.findUniqueOrThrow({ where: { id } }));

  it('two members answer at once: one takes it', async () => {
    const guard = await x.guardOnDuty(s.c);
    const call = await start(guard);
    const both = await Promise.all([
      answer(s.alice, call.id),
      answer(bob, call.id),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = both[0].status === 200 ? s.alice : bob;
    expect(await row(call.id)).toMatchObject({
      status: 'answered',
      answeredByAccountId: winner.id,
    });
    await x.endRaw(guard).expect(200);
  });

  it('an answer against the ring’s timeout: answered, or missed — never both', async () => {
    const guard = await x.guardOnDuty(s.c);
    const call = await start(guard);
    const [res] = await Promise.all([
      answer(s.alice, call.id),
      x.sweep(GATE_CALL_TIMEOUT_SWEEP, new Date(Date.now() + 46_000)),
    ]);
    const after = await row(call.id);
    if (res.status === 200) expect(after.status).toBe('answered');
    else {
      expect(res.status).toBe(409);
      expect(after.status).toBe('missed');
    }
    await x.endRaw(guard).expect(200);
  });

  it('the guard’s end against an answer: one of the two', async () => {
    const guard = await x.guardOnDuty(s.c);
    const call = await start(guard);
    const [ended, answered] = await Promise.all([
      x.http('post', `/gate/calls/${call.id}/end`, guard.token),
      answer(s.alice, call.id),
    ]);
    const after = await row(call.id);
    expect(after.status).toBe('ended');
    expect(ended.status).toBe(200);
    if (answered.status === 200) expect(after.answeredAt).not.toBeNull();
    else expect(after.answeredAt).toBeNull();
    await x.endRaw(guard).expect(200);
  });

  it('a call started while the shift ends is refused, and no call is left', async () => {
    const guard = await x.guardOnDuty(s.c);
    const res = await whileShiftEnds(guard.shiftId, () =>
      x.http('post', '/gate/calls', guard.token, {
        unitId: s.home.id,
        reasonCode: 'other',
      }),
    );
    expect(res.status).toBe(403);
    expect(
      await x.inTx(s.c, (tx) =>
        tx.gateCall.count({ where: { shiftId: guard.shiftId } }),
      ),
    ).toBe(0);
  });

  it('the vendor’s same event twice at once is taken once', async () => {
    const guard = await x.guardOnDuty(s.c);
    const call = await start(guard);
    const event = {
      eventId: randomUUID(),
      roomRef: `fake-room-${call.id}`,
      kind: 'room_closed',
      at: new Date().toISOString(),
    };
    const post = () =>
      h
        .http()
        .post(`${API}/public/gate/calls/${s.c.tenantId}/events`)
        .set(FAKE_CALL_SIGNATURE_HEADER, signFakeCallEvent(event))
        .send(event);
    const both = await Promise.all([post(), post()]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(
      await x.inTx(s.c, (tx) =>
        tx.gateCallVendorEvent.count({
          where: { vendorEventId: event.eventId },
        }),
      ),
    ).toBe(1);
    expect(await row(call.id)).toMatchObject({ endReason: 'vendor' });
  });
});
