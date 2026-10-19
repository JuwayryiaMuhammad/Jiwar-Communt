import { CHILD_RECORDS_PURGE_SWEEP } from '../../src/gate/children/child-records.service';
import { newId } from '../../src/core/common/uuid';
import { auditReaders } from '../setup/audit';
import {
  childrenHelpers,
  type ExitBody,
  type VerifyBody,
  type Who,
} from '../setup/children';
import { at, day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const codeOf = (res: { body: unknown }) => (res.body as { code: string }).code;

/**
 * ADR 0054, at the gate: a guard on shift scans the child's card (the
 * child's first name and photo, who may collect them today), then who takes
 * them. Authorized → recorded; refused → recorded, and the household adults
 * and the roster's keepers are alerted (critical); alone without leave →
 * recorded, the household adults alerted; an authorized exit told when the
 * household asks. The household reads its records for 30 days; the keepers
 * see the unauthorized pickups only, without the child.
 */
describe('Children — at the gate', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof childrenHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof childrenHelpers>['setUp']>>;
  let audit: ReturnType<typeof auditReaders>;
  let supervisor: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = childrenHelpers(h);
    audit = auditReaders(h);
    s = await x.setUp('Gate Children Court');
    supervisor = await x.staff(s.c, ['guard_roster.manage']);
  }, 120_000);

  afterAll(() => h.close());

  /** A controlled child with a family member, an outside escort and a guard on duty. */
  async function scene(
    body: Record<string, unknown> = {
      mayLeaveAlone: false,
      notifyPickups: true,
    },
  ) {
    const { home, primary, memberId, control } = await x.controlled(s.c, body, {
      fullName: 'Omar Hany Saleh',
    });
    const member = await x.family(s.c, home.id, primary);
    const outside = await x.addEscort(
      primary,
      home.id,
      memberId,
      x.outside('Mona Adel Fahmy'),
    );
    const guard = await x.guardOnDuty(s.c);
    return {
      home,
      primary,
      member,
      memberId,
      card: control.card.qrPayload,
      control,
      outside,
      code: outside.pickup!.code,
      guard,
    };
  }

  const kinds = async (accountId: string, targetId: string) =>
    (await x.told(s.c, accountId, targetId)).map((n) => n.kind);

  it("the child's card: a first name, a photo, today's escorts; it writes nothing", async () => {
    const t = await scene();
    const photo = await x.files.ready(t.primary.token, 'child_photo');
    await x
      .http(
        'put',
        `${x.controlPath(t.home.id, t.memberId)}/photo`,
        t.primary.token,
        { fileId: photo },
      )
      .expect(204);
    await x.addEscort(t.primary, t.home.id, t.memberId, {
      kind: 'adult',
      accountId: t.member.id,
    });
    const later = await x.addEscort(t.primary, t.home.id, t.memberId, {
      ...x.outside('Later Person'),
      validFrom: day(2),
    });
    const elsewhere = await x.addEscort(t.primary, t.home.id, t.memberId, {
      ...x.outside('Other Gate'),
      post: { gateId: (await x.g.gate(s.c)).id },
    });
    const before = await x.inTx(s.c, async (tx) => ({
      pickups: await tx.childPickup.count(),
      audit: await tx.auditLog.count(),
    }));
    const res = await x.verifyRaw(t.guard, ` ${t.card} `).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as VerifyBody;
    expect(body.child).toMatchObject({
      firstName: 'Omar',
      mayLeaveAlone: false,
    });
    expect(body.child.photoUrl).toEqual(expect.any(String));
    expect(res.text).not.toMatch(/Hany|Saleh|Adel|Fahmy|\+20/);
    const shown = new Map(body.escorts.map((e) => [e.id, e]));
    expect(shown.get(t.outside.id)).toMatchObject({
      kind: 'outside',
      firstName: 'Mona',
      validNow: true,
    });
    expect(shown.has(later.id)).toBe(false);
    expect(shown.get(elsewhere.id)?.validNow).toBe(false);
    expect([...shown.values()].map((e) => e.kind).sort()).toEqual([
      'adult',
      'outside',
      'outside',
    ]);
    const after = await x.inTx(s.c, async (tx) => ({
      pickups: await tx.childPickup.count(),
      audit: await tx.auditLog.count(),
    }));
    expect(after).toEqual(before);
  });

  it('one answer for any card that is not live here; a guard needs a shift', async () => {
    const t = await scene();
    const reissued = (
      await x
        .http(
          'post',
          `${x.controlPath(t.home.id, t.memberId)}/card`,
          t.primary.token,
        )
        .expect(200)
    ).body as { card: { qrPayload: string } };
    const other = await x.x.compound('Other Children Court');
    const answers: string[] = [];
    for (const card of [
      t.card,
      'JWC1.short',
      `JWC1.${'A'.repeat(43)}`,
      'JWR1.' + reissued.card.qrPayload.slice(5),
    ]) {
      const res = await x.verifyRaw(t.guard, card).expect(404);
      // The same answer, but for the request's own id, time and path.
      const body = res.body as Record<string, unknown>;
      delete body.requestId;
      delete body.timestamp;
      delete body.path;
      answers.push(JSON.stringify(body));
    }
    expect(new Set(answers).size).toBe(1);
    expect(codeOf({ body: JSON.parse(answers[0]) as unknown })).toBe(
      'CHILD_CARD_UNKNOWN',
    );
    // Another compound's guard cannot read this card either.
    const theirs = await x.guardOnDuty(other);
    await x.verifyRaw(theirs, reissued.card.qrPayload).expect(404);
    const offDuty = await x.who(s.c, (await x.g.guard(s.c)).id, 'staff');
    expect(
      codeOf(await x.verifyRaw(offDuty, reissued.card.qrPayload).expect(403)),
    ).toBe('NO_OPEN_SHIFT');
  });

  it('a pickup code: authorized, recorded with ids and codes only, the household told when it asks', async () => {
    const t = await scene();
    const res = await x.exitRaw(t.guard, t.card, { code: t.code }).expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const exit = res.body as ExitBody;
    expect(exit).toMatchObject({
      result: 'authorized',
      outcome: 'picked_up',
      reason: null,
      escort: { kind: 'outside', firstName: 'Mona' },
    });
    const row = await x.pickupRow(s.c, exit.pickupId);
    expect(row).toMatchObject({
      controlId: t.control.id,
      unitId: t.home.id,
      escortId: t.outside.id,
      method: 'pickup_code',
      guardAccountId: t.guard.id,
      gateId: t.guard.gateId,
      placeId: null,
    });
    const [entry] = await audit.tenant(s.c.tenantId, {
      action: 'child_pickup.recorded',
      targetId: exit.pickupId,
    });
    expect(entry.metadata).toEqual({
      outcome: 'picked_up',
      method: 'pickup_code',
    });
    for (const id of [t.control.id, t.memberId, t.home.id, t.outside.id])
      expect(JSON.stringify(entry)).not.toContain(id);
    for (const who of [t.primary, t.member])
      expect(await x.told(s.c, who.id, exit.pickupId)).toEqual([
        { kind: 'child.picked_up', params: { outcome: 'picked_up' } },
      ]);
    expect(await kinds(supervisor.id, exit.pickupId)).toEqual([]);
    expect(await kinds(t.guard.id, exit.pickupId)).toEqual([]);
  });

  it("a resident's QR, a worker's code and a worker's card collect the child when they are its escorts", async () => {
    const t = await scene({ mayLeaveAlone: false, notifyPickups: false });
    await x.addEscort(t.primary, t.home.id, t.memberId, {
      kind: 'adult',
      accountId: t.member.id,
    });
    const nanny = await x.worker(s.c, t.primary, t.home.id);
    await x.addEscort(t.primary, t.home.id, t.memberId, {
      kind: 'worker',
      engagementId: nanny.engagementId,
    });
    const byResident = await x.exit(t.guard, t.card, {
      qr: await x.entryQr(t.member),
    });
    expect(byResident).toMatchObject({
      outcome: 'picked_up',
      escort: { kind: 'adult' },
    });
    // A new guard: the five minutes are per child, so the next exits are
    // their own children's; and nobody was told (notifyPickups off).
    expect(await kinds(t.primary.id, byResident.pickupId)).toEqual([]);
    const second = await scene({ mayLeaveAlone: false, notifyPickups: false });
    const nanny2 = await x.worker(s.c, second.primary, second.home.id);
    await x.addEscort(second.primary, second.home.id, second.memberId, {
      kind: 'worker',
      engagementId: nanny2.engagementId,
    });
    const byCode = await x.exit(second.guard, second.card, {
      code: nanny2.approved!.accessCode,
    });
    expect(byCode).toMatchObject({
      outcome: 'picked_up',
      escort: { kind: 'worker' },
    });
    expect((await x.pickupRow(s.c, byCode.pickupId)).method).toBe(
      'worker_code',
    );
    const third = await scene({ mayLeaveAlone: false, notifyPickups: false });
    const nanny3 = await x.worker(s.c, third.primary, third.home.id);
    await x.addEscort(third.primary, third.home.id, third.memberId, {
      kind: 'worker',
      engagementId: nanny3.engagementId,
    });
    const byCard = await x.exit(third.guard, third.card, {
      qr: nanny3.approved!.card.qrPayload,
    });
    expect((await x.pickupRow(s.c, byCard.pickupId)).method).toBe('worker_qr');
  });

  it('not an escort: refused, the household adults and the keepers alerted (critical), never a landlord', async () => {
    const t = await scene();
    const landlord = await x.landlord(s.c, t.home.id);
    const neighbour = await x.owner(s.c, (await x.unit(s.c)).id);
    const exit = await x.exit(t.guard, t.card, {
      qr: await x.entryQr(neighbour),
    });
    expect(exit).toMatchObject({
      result: 'refused',
      outcome: 'refused',
      reason: 'not_an_escort',
      escort: null,
    });
    for (const who of [t.primary, t.member, supervisor, s.manager])
      expect(await x.told(s.c, who.id, exit.pickupId)).toEqual([
        { kind: 'child.unauthorized_pickup', params: {} },
      ]);
    for (const who of [landlord, neighbour, t.guard])
      expect(await kinds(who.id, exit.pickupId)).toEqual([]);
    const [n] = await x.notifications(
      s.c,
      t.primary.id,
      'child.unauthorized_pickup',
    );
    expect(n.priority).toBe('critical');

    // Another child's pickup code is not this child's escort.
    const other = await scene();
    const wrong = await x.exit(t.guard, t.card, { code: other.code });
    expect(wrong.reason).toBe('not_an_escort');
  });

  it('an escort outside their days or at another post: refused with the reason', async () => {
    const t = await scene();
    const tomorrow = await x.addEscort(t.primary, t.home.id, t.memberId, {
      ...x.outside('Tomorrow Person'),
      validFrom: day(1),
    });
    expect(
      await x.exit(t.guard, t.card, { code: tomorrow.pickup!.code }),
    ).toMatchObject({ outcome: 'refused', reason: 'outside_validity' });
    const otherGate = await x.addEscort(t.primary, t.home.id, t.memberId, {
      ...x.outside('Other Gate Person'),
      post: { gateId: (await x.g.gate(s.c)).id },
    });
    const refused = await x.exit(t.guard, t.card, {
      qr: otherGate.pickup!.qrPayload,
    });
    expect(refused).toMatchObject({
      outcome: 'refused',
      reason: 'wrong_post',
      escort: { kind: 'outside', firstName: 'Other' },
    });
    expect((await x.pickupRow(s.c, refused.pickupId)).escortId).toBe(
      otherGate.id,
    );
  });

  it('a credential nobody can be told from: 422 and nothing recorded; the unidentified are refused and alerted', async () => {
    const t = await scene();
    const count = () => x.inTx(s.c, (tx) => tx.childPickup.count());
    const before = await count();
    for (const escort of [
      { code: '000000' },
      { code: '12345678' },
      { code: '123' },
      { qr: 'JWP1.' + 'B'.repeat(43) },
      { qr: 'nonsense' },
    ])
      expect(codeOf(await x.exitRaw(t.guard, t.card, escort).expect(422))).toBe(
        'CHILD_ESCORT_UNKNOWN',
      );
    expect(await count()).toBe(before);
    const fields = await x.exitRaw(t.guard, t.card, {}).expect(400);
    expect((fields.body as { fields: unknown }).fields).toEqual([
      { field: 'escort.qr', code: 'FIELD_REQUIRED' },
    ]);
    const exit = await x.exit(t.guard, t.card, { unidentified: true });
    expect(exit).toMatchObject({ outcome: 'refused', reason: 'no_credential' });
    expect(await kinds(supervisor.id, exit.pickupId)).toEqual([
      'child.unauthorized_pickup',
    ]);
  });

  it('alone: held without leave (the household alerted, not the keepers); allowed, left alone', async () => {
    const t = await scene();
    const held = await x.exit(t.guard, t.card, { alone: true });
    expect(held).toMatchObject({
      result: 'refused',
      outcome: 'alone_refused',
      reason: 'alone_not_allowed',
    });
    expect(await kinds(t.member.id, held.pickupId)).toEqual([
      'child.exit_alone',
    ]);
    expect(await kinds(supervisor.id, held.pickupId)).toEqual([]);
    const free = await scene({ mayLeaveAlone: true, notifyPickups: true });
    const left = await x.exit(free.guard, free.card, { alone: true });
    expect(left).toMatchObject({ result: 'authorized', outcome: 'left_alone' });
    expect(await x.told(s.c, free.primary.id, left.pickupId)).toEqual([
      { kind: 'child.picked_up', params: { outcome: 'left_alone' } },
    ]);
  });

  it('an Idempotency-Key replays the recorded exit', async () => {
    const t = await scene();
    const key = { 'Idempotency-Key': `exit-${newId()}` };
    const first = await x
      .exitRaw(t.guard, t.card, { code: t.code }, key)
      .expect(201);
    const again = await x
      .exitRaw(t.guard, t.card, { code: t.code }, key)
      .expect(201);
    expect(again.body).toEqual(first.body);
    expect(
      await x.inTx(s.c, (tx) =>
        tx.childPickup.count({ where: { controlId: t.control.id } }),
      ),
    ).toBe(1);
  });

  it("the household reads its children's records; the keepers the unauthorized pickups only, without the child", async () => {
    const t = await scene();
    // A refused attempt first: an authorized exit makes the next five
    // minutes of this child a duplicate (409), never a record.
    const other = await scene();
    const refused = await x.exit(t.guard, t.card, { code: other.code });
    const ok = await x.exit(t.guard, t.card, { code: t.code });
    const list = await x
      .http('get', `/units/${t.home.id}/children/pickups`, t.member.token)
      .expect(200);
    expect(list.headers['cache-control']).toBe('no-store');
    const records = (list.body as { data: { id: string }[] }).data;
    expect(records.map((r) => r.id)).toEqual([ok.pickupId, refused.pickupId]);
    expect(records[0]).toMatchObject({
      memberId: t.memberId,
      firstName: 'Omar',
      outcome: 'picked_up',
      method: 'pickup_code',
      escort: { kind: 'outside', firstName: 'Mona' },
      post: { gateId: t.guard.gateId },
    });
    const landlord = await x.landlord(s.c, t.home.id);
    await x
      .http('get', `/units/${t.home.id}/children/pickups`, landlord.token)
      .expect(403);
    await x
      .http('get', `/units/${t.home.id}/children/pickups`, s.manager.token)
      .expect(403);

    const alerts = await x
      .http('get', '/staff/security/child-alerts', supervisor.token)
      .expect(200);
    const ids = (alerts.body as { data: { id: string }[] }).data.map(
      (a) => a.id,
    );
    expect(ids).toContain(refused.pickupId);
    expect(ids).not.toContain(ok.pickupId);
    const detail = await x
      .http(
        'get',
        `/staff/security/child-alerts/${refused.pickupId}`,
        supervisor.token,
      )
      .expect(200);
    expect(Object.keys(detail.body as object).sort()).toEqual([
      'at',
      'escortKind',
      'guard',
      'id',
      'method',
      'outcome',
      'post',
      'refusalReason',
      'unitCode',
    ]);
    expect(detail.text).not.toMatch(
      new RegExp(`Omar|Mona|${t.memberId}|${t.control.id}`),
    );
    expect(
      codeOf(
        await x
          .http(
            'get',
            `/staff/security/child-alerts/${ok.pickupId}`,
            supervisor.token,
          )
          .expect(404),
      ),
    ).toBe('CHILD_ALERT_NOT_FOUND');
    await x
      .http('get', '/staff/security/child-alerts', t.guard.token)
      .expect(403);
  });

  it('30 days on, the records go, and a revoked outside escort loses the name and phone', async () => {
    const t = await scene();
    const exit = await x.exit(t.guard, t.card, { code: t.code });
    await x
      .http(
        'post',
        `${x.escortsPath(t.home.id, t.memberId)}/${t.outside.id}/revoke`,
        t.primary.token,
      )
      .expect(204);
    await x.sweep(CHILD_RECORDS_PURGE_SWEEP, at(day(29), 12, 0));
    expect(
      await x.inTx(s.c, (tx) =>
        tx.childPickup.count({ where: { id: exit.pickupId } }),
      ),
    ).toBe(1);
    await x.sweep(CHILD_RECORDS_PURGE_SWEEP, at(day(31), 12, 0));
    expect(
      await x.inTx(s.c, (tx) =>
        tx.childPickup.count({ where: { id: exit.pickupId } }),
      ),
    ).toBe(0);
    const escort = await x.inTx(s.c, (tx) =>
      tx.childEscort.findUniqueOrThrow({ where: { id: t.outside.id } }),
    );
    expect(escort).toMatchObject({ fullName: null, phone: null });
    expect(escort.piiClearedAt).not.toBeNull();
    const purged = await audit.tenant(s.c.tenantId, {
      action: 'child_pickup.purged',
    });
    expect(purged.length).toBeGreaterThanOrEqual(1);
    expect(
      await audit.tenant(s.c.tenantId, {
        action: 'child_escort.pii_cleared',
        targetId: t.outside.id,
      }),
    ).toHaveLength(1);
  });
});
