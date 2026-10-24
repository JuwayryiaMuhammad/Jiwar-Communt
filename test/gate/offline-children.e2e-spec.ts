import { newId } from '../../src/core/common/uuid';
import { CHILD_RECORDS_PURGE_SWEEP } from '../../src/gate/children/child-records.service';
import { childCardHash } from '../../src/gate/children/child-tokens';
import { longTag } from '../../src/gate/offline/offline-tags';
import { childrenHelpers } from '../setup/children';
import { dbClock } from '../setup/compound-clock';
import { superuserSql } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  offlineHelpers,
  type BundleBody,
  type TestDevice,
} from '../setup/offline';

// eslint-disable-next-line no-restricted-syntax -- a real 24 h: the child-records purge is now − 30 × 24 h, in ms
const DAY = 86_400_000;

interface ChildSection {
  ref: string;
  card: string;
  mayLeaveAlone: boolean;
  adults: { ref: string; credentials: string[] }[];
}

/**
 * ADR 0057 with ADR 0054: a child under exit control leaving while the gate
 * is offline. Alone with leave, or with a household adult whose ID the
 * guard attests it checked; anyone else is refused offline, the household
 * told. At sync the adult's resident QR is checked against the exit's
 * instant: a QR that does not verify, an escort no longer valid, a leave
 * revoked since, is `left_unverified`, the household and the keepers
 * alerted, a security flag. The action goes with its 30-day record.
 */
describe('Gate offline — children’s exits (ADR 0057)', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof offlineHelpers>;
  let x: ReturnType<typeof childrenHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof offlineHelpers>['setUp']>>;
  let supervisor: Awaited<ReturnType<typeof o.supervisor>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = offlineHelpers(h);
    x = childrenHelpers(h);
    s = await o.setUp('Offline Children Court');
    supervisor = await o.supervisor(s.c);
  }, 180_000);

  afterAll(() => h.close());

  /** A child with control on, an adult of the household as its escort with a phone credential. */
  async function scene(body?: Record<string, unknown>) {
    const t = await x.controlled(s.c, body);
    const adult = await x.family(s.c, t.home.id, t.primary);
    const escort = await x.addEscort(t.primary, t.home.id, t.memberId, {
      kind: 'adult',
      accountId: adult.id,
    });
    const qr = await x.entryQr(adult);
    const { d, b } = await o.deviceWithBundle(s.guard, s.c);
    return { ...t, adult, escort, qr, d, b };
  }
  /**
   * A child's exit the device recorded, at its bundle's issue: inside the
   * server's window [issue − 2 min, receipt] whatever the hour, and however
   * the runner's estimate of the database's clock is off (a time a few ms
   * past the receipt is clamped and flagged `clock_skew`).
   */
  const exit = (
    d: TestDevice,
    b: BundleBody,
    controlId: string,
    over: Record<string, unknown>,
  ) => ({
    clientId: newId(),
    seq: d.seq++,
    deviceTime: b.issuedAt,
    bundleId: b.bundleId,
    type: 'child_exit',
    controlId,
    ...over,
  });
  const pickup = (id: string) => x.pickupRow(s.c, id);
  const alerts = async () =>
    (
      (
        await o
          .http('get', '/staff/security/child-alerts', supervisor.token)
          .expect(200)
      ).body as {
        data: { id: string; outcome: string; refusalReason: string }[];
      }
    ).data;

  it('the bundle carries the card and the adults’ credentials as tags, never the child', async () => {
    const t = await scene();
    const child = (t.b.children as ChildSection[]).find(
      (k) => k.ref === t.control.id,
    )!;
    const token = t.control.card.qrPayload.slice('JWC1.'.length);
    expect(child).toEqual({
      ref: t.control.id,
      card: longTag(
        t.b.bundleId,
        'child-card',
        childCardHash(s.c.tenantId, token),
      ),
      mayLeaveAlone: false,
      adults: [
        {
          ref: t.escort.id,
          credentials: [
            longTag(t.b.bundleId, 'resident-credential', t.qr.split('.')[1]),
          ],
          validFrom: expect.any(String) as string,
          validUntil: null,
          schedule: null,
          gateId: null,
          placeId: null,
        },
      ],
    });
    const text = JSON.stringify(t.b);
    expect(text).not.toContain('Omar');
    expect(text).not.toContain(token);
  });

  it('with the household adult, the ID checked: picked up at its time, the household told', async () => {
    const t = await scene();
    const a = exit(t.d, t.b, t.control.id, {
      escort: 'adult',
      released: true,
      qr: t.qr,
      idChecked: true,
    });
    const [r] = (await o.upload(s.guard, s.c, t.d, [a])).results;
    expect(r).toMatchObject({ status: 'recorded', flags: [] });
    expect(await pickup(a.clientId)).toMatchObject({
      outcome: 'picked_up',
      method: 'resident_qr',
      escortId: t.escort.id,
      guardAccountId: s.guard.id,
      at: new Date(a.deviceTime),
    });
    expect(
      (await o.told(s.c, t.primary.id, a.clientId)).map((n) => n.kind),
    ).toEqual(['child.picked_up']);
  });

  it('a QR that does not verify: left unverified, the household and the keepers alerted, flagged', async () => {
    const t = await scene();
    const forged = `${t.qr.slice(0, -1)}${t.qr.endsWith('A') ? 'B' : 'A'}`;
    const a = exit(t.d, t.b, t.control.id, {
      escort: 'adult',
      released: true,
      qr: forged,
      idChecked: true,
    });
    const up = await o.upload(s.guard, s.c, t.d, [a]);
    expect(up.results[0].flags).toEqual(['child_exit_unverified']);
    expect(await pickup(a.clientId)).toMatchObject({
      outcome: 'left_unverified',
      refusalReason: 'escort_qr_invalid',
      escortId: null,
    });
    for (const who of [t.primary.id, supervisor.id])
      expect((await o.told(s.c, who, a.clientId)).map((n) => n.kind)).toEqual([
        'child.unauthorized_pickup',
      ]);
    expect(await alerts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: a.clientId,
          outcome: 'left_unverified',
          refusalReason: 'escort_qr_invalid',
        }),
      ]),
    );
    expect(await o.told(s.c, s.manager.id, up.batchId)).toEqual([
      { kind: 'gate_offline.security_conflict', params: { flags: 1 } },
    ]);
  });

  it('an escort revoked after the bundle: left unverified, the escort named', async () => {
    const t = await scene();
    await o
      .http(
        'post',
        `/units/${t.home.id}/children/${t.memberId}/control/escorts/${t.escort.id}/revoke`,
        t.primary.token,
      )
      .expect(204);
    const a = exit(t.d, t.b, t.control.id, {
      escort: 'adult',
      released: true,
      qr: t.qr,
      idChecked: true,
    });
    await o.upload(s.guard, s.c, t.d, [a]);
    expect(await pickup(a.clientId)).toMatchObject({
      outcome: 'left_unverified',
      refusalReason: 'escort_inactive',
      escortId: t.escort.id,
    });
  });

  it('alone: left alone with leave; with leave revoked since, left unverified', async () => {
    const free = await scene({ mayLeaveAlone: true, notifyPickups: true });
    const ok = exit(free.d, free.b, free.control.id, {
      escort: 'alone',
      released: true,
    });
    await o.upload(s.guard, s.c, free.d, [ok]);
    expect(await pickup(ok.clientId)).toMatchObject({
      outcome: 'left_alone',
      method: 'alone',
    });
    await superuserSql(
      `UPDATE child_controls SET may_leave_alone = false WHERE id = $1`,
      [free.control.id],
    );
    const late = exit(free.d, free.b, free.control.id, {
      escort: 'alone',
      released: true,
    });
    await o.upload(s.guard, s.c, free.d, [late]);
    expect(await pickup(late.clientId)).toMatchObject({
      outcome: 'left_unverified',
      method: 'alone',
      refusalReason: 'alone_not_allowed',
    });
  });

  it('anyone else is refused offline: the household told, not the keepers', async () => {
    const t = await scene();
    const a = exit(t.d, t.b, t.control.id, {
      escort: 'other',
      released: false,
    });
    const up = await o.upload(s.guard, s.c, t.d, [a]);
    expect(up.results[0]).toMatchObject({ status: 'recorded', flags: [] });
    expect(await pickup(a.clientId)).toMatchObject({
      outcome: 'refused',
      refusalReason: 'offline_unverified',
      method: 'unidentified',
    });
    expect(
      (await o.told(s.c, t.primary.id, a.clientId)).map((n) => n.kind),
    ).toEqual(['child.unauthorized_pickup']);
    expect(await o.told(s.c, supervisor.id, a.clientId)).toEqual([]);
    expect((await alerts()).map((x) => x.id)).not.toContain(a.clientId);
  });

  it('released with an adult, the ID not checked: the payload says no', async () => {
    const t = await scene();
    const res = await o.uploadRaw(s.guard, s.c, t.d, [
      exit(t.d, t.b, t.control.id, {
        escort: 'adult',
        released: true,
        qr: t.qr,
      }),
    ]);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      fields: [{ field: 'payload.actions.0.idChecked', code: 'INVALID_VALUE' }],
    });
  });

  it('the action and its flag go with the record, 30 days on', async () => {
    const t = await scene();
    const a = exit(t.d, t.b, t.control.id, {
      escort: 'adult',
      released: true,
      qr: `${t.qr.slice(0, -2)}xx`,
      idChecked: true,
    });
    const up = await o.upload(s.guard, s.c, t.d, [a]);
    await superuserSql(`UPDATE child_pickups SET at = $2 WHERE id = $1`, [
      a.clientId,
      // eslint-disable-next-line test-clock/day-multiple -- a real 31 × 24 h: past the child-records purge, now − 30 × 24 h
      new Date(dbClock().getTime() - 31 * DAY),
    ]);
    await o.sweep(CHILD_RECORDS_PURGE_SWEEP, dbClock());
    const left = await o.inTx(s.c, async (tx) => ({
      pickup: await tx.childPickup.count({ where: { id: a.clientId } }),
      action: await tx.gateOfflineAction.count({ where: { id: a.clientId } }),
      flags: await tx.gateOfflineFlag.count({
        where: { actionId: a.clientId },
      }),
      batch: await tx.gateOfflineBatch.count({ where: { id: up.batchId } }),
    }));
    expect(left).toEqual({ pickup: 0, action: 0, flags: 0, batch: 1 });
  });
});
