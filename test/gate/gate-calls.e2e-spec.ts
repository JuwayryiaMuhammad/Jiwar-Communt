import { randomUUID } from 'node:crypto';
import { MemberPermissionsService } from '../../src/community/households/member-permissions.service';
import { CALL_DRIVER } from '../../src/gate/calls/call-driver';
import {
  FAKE_CALL_SIGNATURE_HEADER,
  signFakeCallEvent,
  type FakeCallDriver,
} from '../../src/gate/calls/fake-call-driver';
import {
  GATE_CALL_ROOM_SWEEP,
  GATE_CALL_TIMEOUT_SWEEP,
} from '../../src/gate/calls/gate-calls.service';
import { auditReaders } from '../setup/audit';
import { communityHelpers } from '../setup/community';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';
import { securityOpsHelpers, type Who } from '../setup/security-ops';

interface GuardCall {
  id: string;
  unitId: string;
  status: string;
  answered: boolean;
  endReason: string | null;
}
interface ResidentCall {
  id: string;
  gateName: string;
  reasonCode: string;
  status: string;
  answeredByMe: boolean;
}

/**
 * ADR 0068: a masked call from the gate. A guard on shift at a gate rings
 * a unit's household in the app — no number anywhere; the members a gate
 * request goes to are rung critically; the first to answer takes it and
 * the guard learns only that the household answered. It rings for the
 * gate's seconds, then is missed (the control room hears); answered, it
 * lasts at most the gate's other seconds. The shift's end ends it; a room
 * the vendor closed ends it; its room is closed after.
 */
const codeOf = (res: { body: unknown }) => (res.body as { code?: string }).code;

describe('Gate — calls from the gate', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let vendor: FakeCallDriver;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Gate Call Court');
    vendor = h.moduleRef.get<FakeCallDriver>(CALL_DRIVER);
  }, 120_000);

  afterAll(() => h.close());

  /** An adult member who takes gate requests. */
  async function member(): Promise<Who> {
    const cx = communityHelpers(h);
    const joined = await cx.joinFamily(s.c, s.home.id, s.alice);
    await cx.as(s.c, { id: s.alice.id, type: 'resident' }, () =>
      h.moduleRef
        .get(MemberPermissionsService)
        .grant(joined.memberId, 'visitors_invite'),
    );
    return x.who(s.c, joined.accountId, 'family');
  }
  const startRaw = (guard: Who, unitId = s.home.id) =>
    x.http('post', '/gate/calls', guard.token, {
      unitId,
      reasonCode: 'visitor_at_gate',
    });
  const start = async (guard: Who) =>
    (await startRaw(guard).expect(201)).body as GuardCall;
  const asResident = (who: Who, id: string, action: string) =>
    x.http('post', `/me/gate-calls/${id}/${action}`, who.token);
  const row = (id: string) =>
    x.inTx(s.c, (tx) => tx.gateCall.findUniqueOrThrow({ where: { id } }));

  it('rings the household critically, never the guard; one live call a guard and a unit; a unit with nobody to take it refuses', async () => {
    const guard = await x.guardOnDuty(s.c);
    const call = await start(guard);
    expect(call).toMatchObject({ status: 'ringing', answered: false });
    expect(vendor.rooms.get(`fake-room-${call.id}`)).toMatchObject({
      open: true,
    });
    expect(await x.told(s.c, s.alice.id, call.id)).toEqual([
      {
        kind: 'gate.call_incoming',
        params: {
          gateName: expect.any(String) as string,
          reason: 'visitor_at_gate',
        },
      },
    ]);
    expect(await x.told(s.c, guard.id, call.id)).toEqual([]);
    expect((await startRaw(guard).expect(409)).body).toMatchObject({
      code: 'GATE_CALL_LIVE',
      params: { callId: call.id },
    });
    const other = await x.guardOnDuty(s.c);
    await startRaw(other).expect(409);
    const empty = await x.unit(s.c);
    expect(codeOf(await startRaw(other, empty.id).expect(409))).toBe(
      'GATE_CALL_NO_HOUSEHOLD',
    );
    const [audit] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'gate_call.started',
      targetId: call.id,
    });
    expect(audit.metadata).toEqual({
      unitId: s.home.id,
      reasonCode: 'visitor_at_gate',
      shiftId: guard.shiftId,
      rung: 1,
    });
    await x.http('post', `/gate/calls/${call.id}/end`, guard.token).expect(200);
  });

  it('the first answer takes it; the guard learns the household answered, never who; the answerer ends it and the room closes', async () => {
    const guard = await x.guardOnDuty(s.c);
    const bob = await member();
    const call = await start(guard);
    const join = await x
      .http('post', `/gate/calls/${call.id}/join`, guard.token)
      .expect(200);
    expect(join.headers['cache-control']).toBe('no-store');
    expect(join.body).toMatchObject({ token: expect.any(String) as string });

    const answered = await asResident(bob, call.id, 'answer').expect(200);
    expect(answered.headers['cache-control']).toBe('no-store');
    expect(answered.body).toMatchObject({
      call: { status: 'answered', answeredByMe: true },
      join: { token: expect.any(String) as string },
    });
    expect(
      codeOf(await asResident(s.alice, call.id, 'answer').expect(409)),
    ).toBe('GATE_CALL_ANSWERED');
    // The answerer may ask again: their app lost the token.
    await asResident(bob, call.id, 'answer').expect(200);
    expect(
      (
        await x
          .http('get', `/me/gate-calls/${call.id}`, s.alice.token)
          .expect(200)
      ).body as ResidentCall,
    ).toMatchObject({ status: 'answered', answeredByMe: false });
    const seen = (
      await x.http('get', `/gate/calls/${call.id}`, guard.token).expect(200)
    ).body as GuardCall;
    expect(seen).toMatchObject({ status: 'answered', answered: true });
    expect(JSON.stringify(seen)).not.toContain(bob.id);
    // The room's participants are opaque: never an account.
    const room = vendor.rooms.get(`fake-room-${call.id}`)!;
    expect(leakText(room.joined)).not.toMatch(
      new RegExp(`${bob.id}|${guard.id}`),
    );

    await asResident(s.alice, call.id, 'end').expect(404);
    expect(
      ((await asResident(bob, call.id, 'end').expect(200)).body as ResidentCall)
        .status,
    ).toBe('ended');
    expect(await row(call.id)).toMatchObject({
      endReason: 'resident',
      roomClosedAt: expect.any(Date) as Date,
    });
    expect(room.open).toBe(false);
    const [ended] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'gate_call.ended',
      targetId: call.id,
    });
    expect(ended.metadata).toEqual({
      unitId: s.home.id,
      reason: 'resident',
      answered: true,
    });
    expect(leakText(ended)).not.toContain(bob.id);
  });

  it('declined ends it for everyone; unanswered it is missed and the control room hears; answered too long it ends', async () => {
    const guard = await x.guardOnDuty(s.c);
    const one = await start(guard);
    expect(
      (
        (await asResident(s.alice, one.id, 'decline').expect(200))
          .body as ResidentCall
      ).status,
    ).toBe('declined');

    const two = await start(guard);
    await x.sweep(GATE_CALL_TIMEOUT_SWEEP, new Date(Date.now() + 46_000));
    expect(await row(two.id)).toMatchObject({
      status: 'missed',
      endReason: 'missed',
    });
    expect(
      await x.inTx(s.c, (tx) =>
        tx.controlRoomEvent.findFirstOrThrow({ where: { sourceId: two.id } }),
      ),
    ).toMatchObject({ kind: 'gate_call_missed', severity: 'normal' });
    expect(await x.sweep(GATE_CALL_ROOM_SWEEP)).toBeGreaterThanOrEqual(1);
    expect(vendor.rooms.get(`fake-room-${two.id}`)?.open).toBe(false);

    const three = await start(guard);
    await asResident(s.alice, three.id, 'answer').expect(200);
    await x.sweep(GATE_CALL_TIMEOUT_SWEEP, new Date(Date.now() + 301_000));
    expect(await row(three.id)).toMatchObject({
      status: 'ended',
      endReason: 'max_duration',
    });
  });

  it('the shift’s end ends the guard’s live call; a room the vendor closed ends it; a vendor down at the start ends it unavailable', async () => {
    const guard = await x.guardOnDuty(s.c);
    const a = await start(guard);
    await x.endRaw(guard).expect(200);
    expect(await row(a.id)).toMatchObject({
      status: 'ended',
      endReason: 'shift_ended',
    });

    const other = await x.guardOnDuty(s.c);
    const b = await start(other);
    const event = {
      eventId: randomUUID(),
      roomRef: `fake-room-${b.id}`,
      kind: 'room_closed',
      at: new Date().toISOString(),
    };
    const post = (body: object, signature = signFakeCallEvent(body)) =>
      h
        .http()
        .post(`${API}/public/gate/calls/${s.c.tenantId}/events`)
        .set(FAKE_CALL_SIGNATURE_HEADER, signature)
        .send(body);
    await post(event).expect(200);
    await post(event).expect(200);
    expect(await row(b.id)).toMatchObject({
      status: 'ended',
      endReason: 'vendor',
      roomClosedAt: expect.any(Date) as Date,
    });
    expect(
      await x.inTx(s.c, (tx) =>
        tx.gateCallVendorEvent.count({
          where: { vendorEventId: event.eventId },
        }),
      ),
    ).toBe(1);
    await post(event, '0'.repeat(64)).expect(401);

    vendor.failNext('unavailable');
    expect((await startRaw(other).expect(503)).body).toMatchObject({
      code: 'VENDOR_UNAVAILABLE',
      params: { service: 'call' },
    });
    const [down] = await x.inTx(s.c, (tx) =>
      tx.gateCall.findMany({
        where: { guardAccountId: other.id, endReason: 'unavailable' },
      }),
    );
    expect(down).toMatchObject({ status: 'ended', roomRef: null });
  });
});
