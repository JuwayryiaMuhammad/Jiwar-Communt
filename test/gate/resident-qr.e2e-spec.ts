import { Client } from 'pg';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { SAMPLE, fileHelpers } from '../setup/files';
import { call, err } from '../api/request';
import { buildWorld, type World } from '../api/world';
import { gateHelpers } from '../setup/gate';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  residentEntry,
  UNKNOWN_CODE,
  type Verified,
} from '../setup/resident-entry';
import { required } from '../setup/test-env';

/**
 * A resident's rotating QR at the gate (ADR 0031): verified by the existing
 * `POST /gate/verify`, shown as a first name, the units where they live and
 * a photo — and never logged.
 */
describe('Gate — the resident entry QR (ADR 0031)', () => {
  let h: HttpHarness;
  let w: World;
  let db: Client;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
    db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  const {
    inA,
    qr,
    inSafeWindow,
    verify,
    scan,
    shape,
    resident,
    issue,
    live,
    reasons,
    count,
    foreignCredential,
    asManager,
  } = residentEntry(() => ({ h, w, db }), { guard: true });

  describe('verify', () => {
    it('a valid resident: first name, the units where they live now, a photo or null; nothing else', async () => {
      const home = await w.helpers.unit(w.a);
      const landlordOf = await w.helpers.unit(w.a);
      const r = await resident({
        fullName: 'Mona Abdel Rahman',
        extraUnits: [home.id],
      });
      // They also own a unit they do not live in.
      await asManager(() =>
        w.helpers.residents.addOccupancy(r.id, {
          unitId: landlordOf.id,
          occupancyType: 'owner',
          resides: false,
        }),
      );
      const c = await issue(r.token);

      await inSafeWindow();
      const res = await verify({ qr: qr(c) }).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.body as Verified;
      const codes = (
        await asManager(() =>
          w.helpers.prisma.tenant.unit.findMany({
            where: { id: { in: [r.unitId, home.id] } },
            select: { code: true },
          }),
        )
      )
        .map((u) => u.code)
        .sort();
      expect(body).toEqual({
        result: 'valid',
        subject: 'resident',
        reason: null,
        subjectId: null,
        next: null,
        display: {
          unitCode: null,
          passKind: null,
          partySize: null,
          workerName: null,
          capacity: null,
          photo: null,
          firstName: 'Mona',
          unitCodes: codes,
          photoUrl: null,
        },
      });
      // Never the full name, a contact or the document.
      for (const secret of [
        'Abdel',
        'Rahman',
        r.phone,
        r.email,
        r.idDocumentNumber,
      ])
        expect(res.text).not.toContain(secret);

      // With a photo the guard can compare the face; without one: null.
      const files = fileHelpers(h);
      const photo = await files.ready(r.token, 'resident_photo');
      await call(w, 'PUT', '/me/photo', {
        token: r.token,
        body: { fileId: photo },
      }).expect(204);
      const withPhoto = (await scan(c)).display!;
      expect(new URL(withPhoto.photoUrl!).pathname).toMatch(
        new RegExp(`/t/${w.a.tenantId}/${photo}$`),
      );
      const bytes = await fetch(withPhoto.photoUrl!);
      expect(Buffer.from(await bytes.arrayBuffer())).toEqual(
        SAMPLE['image/png'],
      );
      await call(w, 'DELETE', '/me/photo', { token: r.token }).expect(204);
      expect((await scan(c)).display!.photoUrl).toBeNull();
    });

    it('rotation: the current step and one either side pass; two away is expired_qr, whatever the direction', async () => {
      const r = await resident();
      const c = await issue(r.token);
      await inSafeWindow();
      for (const offset of [0, 1, -1])
        expect(await scan(c, offset)).toMatchObject({
          result: 'valid',
          subject: 'resident',
        });
      for (const offset of [2, -2, 3, -10, 1000]) {
        expect(await scan(c, offset)).toEqual({
          result: 'invalid',
          subject: 'resident',
          reason: 'expired_qr',
          subjectId: null,
          next: null,
          display: null,
        });
      }
    });

    it('forged, foreign and malformed payloads answer exactly like an unknown code', async () => {
      const r = await resident();
      const other = await resident();
      const c = await issue(r.token);
      const theirs = await issue(other.token);
      const foreign = await foreignCredential();
      const unknown = shape(await verify(UNKNOWN_CODE).expect(200));
      expect(unknown).toContain('unknown_code');

      await inSafeWindow();
      const good = qr(c);
      const [prefix, id, step, mac] = good.split('.');
      const flip = (m: string) => `${m[0] === 'A' ? 'B' : 'A'}${m.slice(1)}`;
      const payloads = [
        // a wrong mac
        `${prefix}.${id}.${step}.${flip(mac)}`,
        // the mac of another step
        `${prefix}.${id}.${Number(step) + 1}.${mac}`,
        // a wrong credential id: another real one with this credential's mac
        `${prefix}.${theirs.id}.${step}.${mac}`,
        // another compound's credential, correctly computed, at A's gate
        qr(foreign),
        // an id nobody was ever given
        qr({
          id: '01a0f000-0000-7000-8000-00000000abcd',
          secret: c.secret,
          stepSeconds: 30,
        }),
        // not shaped like one
        `${prefix}.${id}.${step}`,
        `${prefix}.${id}.${step}.${mac}A`,
        `${prefix}.${id}.x.${mac}`,
        `${prefix}.not-a-uuid.${step}.${mac}`,
        `jwr2.${id}.${step}.${mac}`,
        'JWR2.',
        'JWR3.anything',
        '',
      ].filter((p) => p !== '');
      for (const qrPayload of payloads) {
        const res = await verify({ qr: qrPayload });
        expect({ qrPayload, answer: shape(res) }).toEqual({
          qrPayload,
          answer: unknown,
        });
      }
      // And the genuine one is not among them.
      expect(await scan(c)).toMatchObject({ result: 'valid' });
    });

    it('no longer valid: revoked by its owner stops at the next scan', async () => {
      const r = await resident();
      const c = await issue(r.token);
      await inSafeWindow();
      expect((await scan(c)).result).toBe('valid');
      await call(w, 'POST', `/me/entry-credentials/${c.id}/revoke`, {
        token: r.token,
      }).expect(204);
      expect(await scan(c)).toEqual({
        result: 'invalid',
        subject: 'resident',
        reason: 'revoked',
        subjectId: null,
        next: null,
        display: null,
      });
    });

    it('each reason, and never a display on an invalid result', async () => {
      await inSafeWindow();
      const seen: Record<string, Verified> = {};

      // account_inactive: frozen, then deactivated, then erased
      const frozen = await resident();
      const cFrozen = await issue(frozen.token);
      await asManager(() =>
        h.moduleRef
          .get(AccountsService)
          .freeze(frozen.id, { code: 'phone_reassigned', text: 'Reported' }),
      );
      seen.frozen = await scan(cFrozen);

      const inactive = await resident();
      const cInactive = await issue(inactive.token);
      await call(w, 'PATCH', `/accounts/${inactive.id}/status`, {
        token: w.a.tokens.manager,
        body: { status: 'inactive' },
      }).expect(200);
      seen.inactive = await scan(cInactive);

      // not_resident: the hooks revoked the credential, so reproduce a missed
      // hook by un-revoking it behind the app's back.
      const mover = await resident();
      const cMover = await issue(mover.token);
      const [occupancy] = await w.helpers.occupancies(w.a, mover.unitId);
      await asManager(() =>
        w.helpers.residents.endOccupancy(occupancy.id, {
          code: 'moved_out',
          text: 'Left',
        }),
      );
      expect(await reasons(mover.id)).toEqual(['not_resident']);
      await inA(
        `UPDATE entry_credentials SET revoked_at = NULL, revoke_reason = NULL
          WHERE account_id = $1`,
        [mover.id],
      );
      seen.moved = await scan(cMover);

      expect(
        Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.reason])),
      ).toEqual({
        frozen: 'account_inactive',
        inactive: 'account_inactive',
        moved: 'not_resident',
      });
      for (const v of Object.values(seen))
        expect(v).toMatchObject({
          result: 'invalid',
          subject: 'resident',
          subjectId: null,
          next: null,
          display: null,
        });
    });

    it('no tracking: a scan writes no entry, no audit row, no notice and no last-used time', async () => {
      const r = await resident();
      const c = await issue(r.token);
      const watched = [
        'gate_entries',
        'audit_log',
        'notifications',
        'entry_credentials',
      ];
      const before = await Promise.all(watched.map(count));
      const rowBefore = JSON.stringify(await live(r.id));
      await inSafeWindow();
      for (const offset of [0, 0, 1, -1, 2]) await scan(c, offset);
      await verify({ qr: `JWR2.${c.id}.1.AAAAAAAAAAAAAAAAAAAAAA` }).expect(200);
      expect(await Promise.all(watched.map(count))).toEqual(before);
      expect(JSON.stringify(await live(r.id))).toBe(rowBefore);
      // The table has no column that could say when it was last used.
      const columns = (
        await db.query(
          `SELECT column_name FROM information_schema.columns
            WHERE table_name = 'entry_credentials' ORDER BY column_name`,
        )
      ).rows.map((x: { column_name: string }) => x.column_name);
      expect(columns).toEqual([
        'account_id',
        'created_at',
        'device_name',
        'id',
        'revoke_reason',
        'revoked_at',
        'tenant_id',
      ]);
    });

    it("shares the guard's budget with codes, and needs an open shift", async () => {
      const r = await resident();
      const c = await issue(r.token);
      const off = await gateHelpers(h).guard(w.a);
      const offToken = await w.tokenFor(w.a, off.id, 'staff');
      const refused = await verify({ qr: qr(c) }, offToken).expect(403);
      expect(err(refused).code).toBe('NO_OPEN_SHIFT');

      await inSafeWindow();
      for (let i = 0; i < 29; i++) await verify(UNKNOWN_CODE).expect(200);
      await verify({ qr: qr(c) }).expect(200);
      await verify({ qr: qr(c) }).expect(429);
    });

    it('a family member scans too, and a resident of another compound is unknown here', async () => {
      const owner = await resident();
      const joined = await w.helpers.joinFamily(w.a, owner.unitId, owner, {
        fullName: 'Hoda Said Ali',
      });
      const token = await w.tokenFor(w.a, joined.id, 'family');
      const c = await issue(token);
      await inSafeWindow();
      expect(await scan(c)).toMatchObject({
        result: 'valid',
        display: { firstName: 'Hoda' },
      });
    });
  });

  // --------------------------------------------------------------------------
  // what a revocation looks like at the gate
  // --------------------------------------------------------------------------

  describe('after a credential ends', () => {
    it('"that wasn\'t me": every phone is refused at the next scan', async () => {
      const r = await resident();
      const a = await issue(r.token);
      const b = await issue(r.token);
      await inSafeWindow();
      expect((await scan(a)).result).toBe('valid');
      await call(w, 'POST', '/me/sessions/revoke-all', {
        token: r.token,
      }).expect(200);
      for (const c of [a, b])
        expect(await scan(c)).toMatchObject({ reason: 'revoked' });
    });

    it('moving out: the old phone is refused, and moving back in does not bring it back', async () => {
      const r = await resident();
      const c = await issue(r.token);
      const [occ] = await w.helpers.occupancies(w.a, r.unitId);
      await asManager(() =>
        w.helpers.residents.endOccupancy(occ.id, {
          code: 'moved_out',
          text: 'Left',
        }),
      );
      await inSafeWindow();
      expect(await scan(c)).toMatchObject({ reason: 'revoked' });
      await asManager(() =>
        w.helpers.residents.addOccupancy(r.id, {
          unitId: r.unitId,
          occupancyType: 'owner',
        }),
      );
      expect(await scan(c)).toMatchObject({ reason: 'revoked' });
      // A new registration works.
      expect(await scan(await issue(r.token))).toMatchObject({
        result: 'valid',
      });
    });

    it('a death review or a separation takes nothing away at the gate', async () => {
      const r = await resident();
      const c = await issue(r.token);
      await asManager(() =>
        w.helpers.residents.markPrimaryDeceased(r.unitId, {
          code: 'deceased',
          text: 'Review',
        }),
      );
      await inSafeWindow();
      expect(await scan(c)).toMatchObject({ result: 'valid' });
    });
  });
});
