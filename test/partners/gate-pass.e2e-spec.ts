import { gateHelpers } from '../setup/gate';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  partnersHelpers,
  shiftWindow,
  type DeskRequestBody,
  type PartnersSetUp,
  type RequestBody,
} from '../setup/partners';

interface DeskPass {
  code: string | null;
  link: string | null;
  qrPayload: string | null;
  validFrom: string;
  validUntil: string;
  partySize: number;
}

/**
 * The partner's service pass (ADR 0060 §3): an accepted request gives the
 * partner's staff the gate's own one-time pass, in the requester's name,
 * for the agreed window; the desk shows it from two hours before the
 * window until it ends; a cancelled request cancels it. No new gate logic:
 * the guard verifies its code as any pass's.
 */
describe('Partners: the service pass (ADR 0060)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof partnersHelpers>;
  let s: PartnersSetUp;
  let partnerId: string;
  let token: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = partnersHelpers(h);
    s = await p.setUp();
    partnerId = await p.partner(s.c, s.keeper);
    token = await p.deskLink(s.keeper, partnerId);
    await p.consent(s.alice);
    await p
      .http('patch', '/staff/partner-settings', s.manager.token, {
        maxLiveRequests: 20,
      })
      .expect(200);
  }, 180_000);

  afterAll(() => h.close());

  const accept = async (over: Record<string, unknown> = {}, staffCount = 2) => {
    const body = await p.request(s.alice, s.homeA.id, partnerId, over);
    await p
      .desk(token, `/requests/${body.id}/accept`, { staffCount })
      .expect(200);
    return body.id;
  };
  const mine = async (id: string) =>
    (await p.http('get', `/partner-requests/${id}`, s.alice.token).expect(200))
      .body as RequestBody & { passId: string | null };
  const onDesk = async (id: string) =>
    (
      (await p.desk(token, '/lookup').expect(200)).body as {
        requests: (DeskRequestBody & { pass: DeskPass | null })[];
      }
    ).requests.find((r) => r.id === id)!;

  it('is the requester’s one-time pass for the agreed window, for as many as come', async () => {
    const id = await accept({}, 3);
    const request = await p.row(s.c, id);
    expect(request.passId).not.toBeNull();
    const pass = await p.inTx(s.c, (tx) =>
      tx.visitorPass.findUniqueOrThrow({ where: { id: request.passId! } }),
    );
    expect(pass).toMatchObject({
      hostAccountId: s.alice.id,
      unitId: s.homeA.id,
      kind: 'one_time',
      partySize: 3,
      status: 'active',
    });
    expect(pass.validFrom.getTime()).toBe(
      request.agreedStartsAt!.getTime() - 30 * 60_000,
    );
    expect(pass.validUntil.getTime()).toBe(
      request.agreedEndsAt!.getTime() + 60 * 60_000,
    );
    expect((await mine(id)).passId).toBe(pass.id);
    // It is one of the requester's passes, read as any other.
    await p
      .http('get', `/visitor-passes/${pass.id}`, s.alice.token)
      .expect(200);
    const steps = (await mine(id)).history!.map((x) => x.kind);
    expect(steps).toEqual(['created', 'accepted', 'pass_issued']);
  });

  it('the desk shows it only from two hours before the window until it ends', async () => {
    const id = await accept();
    // Two days ahead: not yet.
    expect((await onDesk(id)).pass).toBeNull();
    await shiftWindow(id, 'started');
    const shown = (await onDesk(id)).pass!;
    expect(shown.code).toMatch(/^\d{6}$/);
    expect(shown.link).toContain('/v#');
    expect(shown.partySize).toBe(2);
    await shiftWindow(id, 'ended');
    expect((await onDesk(id)).pass).toBeNull();
  });

  it('opens the gate as any pass: the guard verifies its code', async () => {
    const id = await accept();
    await shiftWindow(id, 'started');
    const code = (await onDesk(id)).pass!.code!;
    const duty = await gateHelpers(h).onDuty(s.c);
    const guard = await p.who(s.c, duty.guardId, 'staff');
    const res = await p
      .http('post', '/gate/verify', guard.token, { code })
      .expect(200);
    expect(res.body).toMatchObject({ next: 'in' });
  });

  it('a request cancelled after its acceptance cancels its pass; a declined one never had one', async () => {
    const id = await accept();
    const passId = (await p.row(s.c, id)).passId!;
    await p
      .http('post', `/partner-requests/${id}/cancel`, s.alice.token, {
        reasonCode: 'no_longer_needed',
      })
      .expect(200);
    const pass = await p.inTx(s.c, (tx) =>
      tx.visitorPass.findUniqueOrThrow({ where: { id: passId } }),
    );
    expect(pass).toMatchObject({
      status: 'cancelled',
      cancelReasonCode: 'service_cancelled',
    });
    expect((await mine(id)).history!.map((x) => x.kind)).toContain(
      'pass_cancelled',
    );
  });

  it('a request that asked for none gets none', async () => {
    const id = await accept({ gatePass: false });
    expect((await p.row(s.c, id)).passId).toBeNull();
  });

  it('skipped, never refused, when the requester may no longer invite visitors: the acceptance stands', async () => {
    const member = await p.family(s.c, s.homeA.id, s.alice);
    await p.canInvite(s.c, s.alice, member.memberId, true);
    await p.consent(member);
    const body = await p.request(member, s.homeA.id, partnerId);
    // The primary takes the grant back before the partner answers.
    await p.canInvite(s.c, s.alice, member.memberId, false);
    await p.desk(token, `/requests/${body.id}/accept`).expect(200);
    const row = await p.row(s.c, body.id);
    expect(row).toMatchObject({ status: 'accepted', passId: null });
    const skipped = await p.inTx(s.c, (tx) =>
      tx.partnerRequestEvent.findFirstOrThrow({
        where: { requestId: body.id, kind: 'pass_skipped' },
      }),
    );
    expect(skipped.reasonCode).toBe('host_cannot_invite');
  });
});
