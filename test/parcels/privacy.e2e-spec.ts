import type { Response } from 'supertest';
import { call } from '../api/request';
import { buildWorld, type World } from '../api/world';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { parcelHelpers, parcelScenes } from '../setup/parcels';

const LABEL = 'PII-LIFE-label';
const DELEGATE = 'PII-LIFE-delegate';

/**
 * ADR 0035's privacy rules over one whole life of a parcel: who sees which
 * name, that nothing personal reaches the audit trail, a notification or a
 * stored idempotency body, and that whatever carries a code, a name or a
 * photo is never cached.
 */
describe('Parcels — privacy over a whole life', () => {
  let h: HttpHarness;
  let w: World;
  let s: ReturnType<typeof parcelScenes>;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    s = parcelScenes(w);
  }, 120_000);

  afterAll(() => h.close());

  it('the guard never sees the label, the managers never see a name, the residents see both', async () => {
    const home = await s.household();
    const guard = await s.guardOnDuty(w.a);
    const seen: { who: string; what: string; res: Response }[] = [];
    const note = (who: string, what: string, res: Response) => {
      seen.push({ who, what, res });
      return res;
    };

    // Received by the guard, who typed the label.
    const received = note(
      'guard',
      'receive',
      await parcelHelpers(h).receive(guard.token, home.unitCode, {
        labelName: LABEL,
        carrier: 'amazon',
      }),
    );
    expect(received.status).toBe(201);
    const id = (received.body as { id: string }).id;

    // The unit's residents: both names, a delegate, the codes.
    const mine = note(
      'owner',
      'get',
      await call(w, 'GET', `/me/parcels/${id}`, { token: home.owner.token }),
    );
    expect(mine.text).toContain(LABEL);
    const delegateRes = note(
      'owner',
      'delegate',
      await call(w, 'POST', `/me/parcels/${id}/delegate`, {
        token: home.owner.token,
        body: { name: DELEGATE },
      }),
    );
    expect(delegateRes.status).toBe(201);
    const view = (
      await call(w, 'GET', `/me/parcels/${id}`, { token: home.member.token })
    ).body as {
      pickup: { code: string; qrPayload: string };
      delegate: { code: string; qrPayload: string };
    };
    const codes = [view.pickup.code, view.delegate.code];
    const secrets = [
      view.pickup.qrPayload,
      view.delegate.qrPayload,
      ...[view.pickup.qrPayload, view.delegate.qrPayload].map((q) =>
        q.slice('JWP1.'.length),
      ),
    ];

    // The guard's reads.
    for (const path of [`/gate/parcels/${id}`, '/gate/parcels']) {
      note(
        'guard',
        path,
        await call(w, 'GET', path, {
          token: guard.token,
          query: path === '/gate/parcels' ? { unitCode: home.unitCode } : {},
        }),
      );
    }
    // A manager's.
    for (const path of [`/parcels/${id}`, '/parcels']) {
      note(
        'manager',
        path,
        await call(w, 'GET', path, {
          token: w.a.tokens.manager,
          query: path === '/parcels' ? { unitCode: home.unitCode } : {},
        }),
      );
    }
    // The guard looks the delegate's code up, then hands the parcel over.
    const looked = note(
      'guard',
      'lookup',
      await call(w, 'POST', '/gate/parcels/lookup', {
        token: guard.token,
        body: { code: view.delegate.code },
      }),
    );
    expect(looked.body).toMatchObject({ delegateName: DELEGATE });
    const handed = note(
      'guard',
      'handover',
      await call(w, 'POST', `/gate/parcels/${id}/handover`, {
        token: guard.token,
        body: { code: view.delegate.code },
      }).set('Idempotency-Key', `privacy-${id}`),
    );
    expect(handed.status).toBe(200);
    expect(handed.body).toMatchObject({ delegateName: DELEGATE });
    for (const path of [`/gate/parcels/${id}`, `/parcels/${id}`])
      note(
        path.startsWith('/gate') ? 'guard' : 'manager',
        `${path} after`,
        await call(w, 'GET', path, {
          token: path.startsWith('/gate') ? guard.token : w.a.tokens.manager,
        }),
      );

    for (const { who, what, res } of seen) {
      const where = `${who} ${what}`;
      // The label is the residents' alone.
      if (who !== 'owner' && who !== 'member')
        expect([where, res.text.includes(LABEL)]).toEqual([where, false]);
      // The delegate's name: residents, and the guard at the lookup and the
      // hand-over of a valid delegate code, and nowhere else.
      const guardMoment = what === 'lookup' || what === 'handover';
      if (!(who === 'owner' || who === 'member' || guardMoment))
        expect([where, res.text.includes(DELEGATE)]).toEqual([where, false]);
      // No code, QR or token in what the guard and the managers read, but
      // the delegate's code the guard typed does not come back either.
      if (who === 'guard' || who === 'manager')
        for (const secret of [...codes, ...secrets])
          expect([where, res.text.includes(secret)]).toEqual([where, false]);
      // What carries a code, a name or a photo is never cached.
      if (
        res.status < 300 &&
        (res.text.includes('"photo"') ||
          res.text.includes('"pickup"') ||
          res.text.includes('"delegateName"') ||
          res.text.includes('"labelName"'))
      )
        expect([where, res.headers['cache-control']]).toEqual([
          where,
          'no-store',
        ]);
    }

    // Nothing personal in the trail, a notification or a stored body.
    const bad = [LABEL, DELEGATE, ...codes, ...secrets];
    const rows = await w.helpers.asManager(w.a, async () => {
      const prisma = w.helpers.prisma.tenant;
      return {
        audit: await prisma.auditLog.findMany({
          where: {
            OR: [{ targetId: id }, { action: { startsWith: 'parcel.' } }],
          },
        }),
        notifications: await prisma.notification.findMany({
          where: { kind: { startsWith: 'parcel.' } },
        }),
        keys: await prisma.idempotencyKey.findMany({
          where: { resourceId: id },
        }),
        events: await prisma.parcelEvent.findMany({ where: { parcelId: id } }),
        credentials: await prisma.parcelCredential.findMany({
          where: { parcelId: id },
        }),
      };
    });
    for (const [name, list] of Object.entries(rows)) {
      // The credentials hold the delegate's name until the retention sweep
      // (and only that); the rest never does.
      const text = JSON.stringify(list);
      for (const b of bad) {
        if (name === 'credentials' && b === DELEGATE) continue;
        expect([name, text.includes(b)]).toEqual([name, false]);
      }
    }
    // The credentials keep no code and no token, only HMACs.
    const stored = JSON.stringify(rows.credentials);
    for (const secret of [...codes, ...secrets])
      expect(stored).not.toContain(secret);
    expect(
      rows.credentials.every(
        (c) => c.codeHash === null && c.qrTokenHash === null,
      ),
    ).toBe(true);
    // The hand-over's own entry names the method and nobody who received it
    // (the owner is the actor of the delegate's authorization, rightly).
    const handedOver = rows.audit.filter(
      (r) => r.action === 'parcel.handed_over',
    );
    expect(handedOver.length).toBeGreaterThan(0);
    expect(JSON.stringify(handedOver)).not.toContain(home.owner.id);
  });
});
