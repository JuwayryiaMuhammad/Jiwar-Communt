import { createHash } from 'node:crypto';
import { IdentifierHasher } from '../../src/core/auth/identifier';
import { deriveEngagementToken } from '../../src/community/workers/engagement-tokens';
import { bundleMessage } from '../../src/gate/offline/bundle-signer';
import { signedBy } from '../../src/gate/offline/device-envelope';
import {
  DEVICE_ENVELOPES_SWEEP,
  ENVELOPE_WINDOW_MS,
} from '../../src/gate/offline/device-envelopes';
import { BUNDLE_RATE_PER_MINUTE } from '../../src/gate/offline/gate-bundles.service';
import { longTag, shortTag } from '../../src/gate/offline/offline-tags';
import { dbClock } from '../setup/compound-clock';
import { superuserSql } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  envelope,
  newDevice,
  offlineHelpers,
  signAs,
  type BundleBody,
} from '../setup/offline';

const HOUR = 3_600_000;
/** What the household and the management wrote: never in a bundle. */
const VISITOR = 'Bundle-Visitor Okonkwo';
const PHONE = '+201099887766';
const PLATE = 'ب ن د 6620';
const PLATE_KEY = 'بند6620';

/** The test ring (test/setup/test-env.ts): version 2 is current. */
const ring = new Map(
  process.env
    .ENGAGEMENT_TOKEN_KEYS!.split(',')
    .map((p) => p.split(':') as [string, string])
    .map(([v, k]) => [Number(v), k]),
);

/**
 * ADR 0057, the gate bundle: what a device on duty at a gate downloads to
 * decide entries without network. Signed by the server; tags it can check
 * but not reverse; numbered per device; valid to the shift's planned end;
 * never a name, a phone, a code or a plate in clear. Asked for in a signed
 * envelope, once each.
 */
describe('Gate offline — the bundle (ADR 0057)', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof offlineHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof offlineHelpers>['setUp']>>;
  let hasher: IdentifierHasher;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = offlineHelpers(h);
    s = await o.setUp('Offline Bundles Court');
    hasher = h.moduleRef.get(IdentifierHasher);
  }, 180_000);

  afterAll(() => h.close());

  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const reason = (res: { body: unknown }) =>
    (res.body as { params?: { reason?: string } }).params?.reason;
  const salt = (b: BundleBody) => Buffer.from(b.salt, 'base64url');

  describe('issued', () => {
    it('signed with a published key; the device’s first; the server keeps its hash only', async () => {
      const d = await o.enrol(s.guard, s.c);
      const { signed, body } = await o.bundle(s.guard, s.c, d);
      const { keys } = await o.keys(s.guard);
      const key = keys.find((k) => k.version === signed.keyVersion)!;
      expect(key.current).toBe(true);
      expect(
        signedBy(key.publicKey, bundleMessage(signed.body), signed.signature),
      ).toBe(true);
      expect(body).toMatchObject({
        v: 1,
        tenantId: s.c.tenantId,
        deviceId: d.id,
        version: 1,
        shiftId: s.guard.shiftId,
        gateId: s.guard.gateId,
        guardId: s.guard.id,
        keyVersion: signed.keyVersion,
        lockdown: null,
      });
      expect(Buffer.from(body.salt, 'base64url')).toHaveLength(32);
      // No roster slot: twelve hours.
      expect(
        new Date(body.validUntil).getTime() - new Date(body.issuedAt).getTime(),
      ).toBe(12 * HOUR);
      const row = await o.inTx(s.c, (tx) =>
        tx.gateOfflineBundle.findUniqueOrThrow({
          where: { id: body.bundleId },
        }),
      );
      expect(row).toMatchObject({
        deviceId: d.id,
        version: 1,
        keyVersion: signed.keyVersion,
        contentSha256: createHash('sha256').update(signed.body).digest('hex'),
      });
      expect(row.counts).toMatchObject({ passes: body.passes.length });
      expect(await o.deviceRow(s.c, d.id)).toMatchObject({
        bundleVersion: 1,
        lastBundleAt: row.issuedAt,
      });
      // The next one is the next number, with a salt of its own.
      const next = await o.bundle(s.guard, s.c, d);
      expect(next.body.version).toBe(2);
      expect(next.body.salt).not.toBe(body.salt);
    });

    it('a pass as tags of its code, QR and plate; never the visitor', async () => {
      const pass = await o.passFull(s.alice, s.home.id, {
        visitorName: VISITOR,
        visitorPhone: PHONE,
        vehiclePlate: PLATE,
      });
      const d = await o.enrol(s.guard, s.c);
      const { signed, body } = await o.bundle(s.guard, s.c, d);
      const p = body.passes.find((x) => x.ref === pass.id)!;
      expect(p).toMatchObject({
        unitCode: s.unitCode,
        kind: 'one_time',
        partySize: 1,
        entriesUsed: 0,
        inside: 0,
        schedule: null,
        code: shortTag(salt(body), 'visitor-code', pass.code),
        qr: longTag(
          body.bundleId,
          'visitor-qr',
          pass.qrPayload.slice('JWR1.'.length),
        ),
        plate: shortTag(salt(body), 'plate', PLATE_KEY),
      });
      const text = Buffer.from(signed.body, 'base64url').toString('utf8');
      for (const secret of [
        VISITOR,
        PHONE,
        PLATE,
        PLATE_KEY,
        pass.code,
        pass.qrPayload,
      ])
        expect(text).not.toContain(secret);
    });

    it('a cancelled pass is not carried', async () => {
      const pass = await o.passFull(s.alice, s.home.id);
      await o
        .http('post', `/visitor-passes/${pass.id}/cancel`, s.alice.token, {
          reasonCode: 'not_needed',
        })
        .expect(204);
      const { body } = await o.bundle(
        s.guard,
        s.c,
        await o.enrol(s.guard, s.c),
      );
      expect(body.passes.map((x) => x.ref)).not.toContain(pass.id);
    });

    it('a worker’s derived card, one derived with a retired version, never a random one', async () => {
      const w = await o.workerWithCard(s.c, s.alice, s.home.id);
      // A card printed before the rotation: version 1 while 2 is current.
      const old = await o.workerWithCard(s.c, s.alice, s.home.id);
      const oldToken = deriveEngagementToken(
        ring.get(1)!,
        s.c.tenantId,
        old.engagementId,
        7,
      );
      const oldCode = hasher.deriveCode(oldToken, 8);
      await superuserSql(
        `UPDATE worker_engagements
            SET access_code_hash = $2, qr_token_hash = $3,
                token_seq = 7, token_key_version = 1
          WHERE id = $1`,
        [
          old.engagementId,
          hasher.hashWorkerCode(s.c.tenantId, oldCode),
          hasher.hashQrToken(s.c.tenantId, oldToken),
        ],
      );
      // A random card from before ADR 0057.
      const random = await o.workerWithCard(s.c, s.alice, s.home.id);
      await superuserSql(
        `UPDATE worker_engagements SET token_seq = NULL, token_key_version = NULL
          WHERE id = $1`,
        [random.engagementId],
      );
      const { signed, body } = await o.bundle(
        s.guard,
        s.c,
        await o.enrol(s.guard, s.c),
      );
      const byRef = new Map(body.workers.map((x) => [x.ref, x]));
      expect(byRef.get(w.engagementId)).toMatchObject({
        unitCode: s.unitCode,
        capacity: 'nanny',
        inside: 0,
        code: shortTag(salt(body), 'worker-code', w.code),
        qr: longTag(body.bundleId, 'worker-qr', w.qr.slice('JWR1.'.length)),
      });
      expect(byRef.get(old.engagementId)).toMatchObject({
        code: shortTag(salt(body), 'worker-code', oldCode),
        qr: longTag(body.bundleId, 'worker-qr', oldToken),
      });
      expect(byRef.has(random.engagementId)).toBe(false);
      const row = await o.inTx(s.c, (tx) =>
        tx.gateOfflineBundle.findUniqueOrThrow({
          where: { id: body.bundleId },
        }),
      );
      expect(
        (row.counts as Record<string, number>).workersNotDerivable,
      ).toBeGreaterThanOrEqual(1);
      // The management sees it on the device.
      expect(
        (await o.deviceView(s.manager, row.deviceId)).notCarried.workers,
      ).toBe((row.counts as Record<string, number>).workersNotDerivable);
      const text = Buffer.from(signed.body, 'base64url').toString('utf8');
      for (const secret of [w.fullName, w.code, oldCode, oldToken])
        expect(text).not.toContain(secret);
    });

    it('banned and watched plates as tags; never a person, a lifted entry or a name', async () => {
      const ban = await o.block(s.manager, {
        subject: 'plate',
        plate: 'ق ف 3101',
      });
      const watch = await o.block(s.manager, {
        kind: 'watch',
        subject: 'plate',
        plate: 'ق ف 3102',
      });
      const person = await o.block(s.manager, {
        subject: 'person',
        fullName: 'Bundle-Banned Person',
        idNumber: '29001010011223',
      });
      const lifted = await o.block(s.manager, {
        subject: 'plate',
        plate: 'ق ف 3103',
      });
      await o
        .http(
          'post',
          `/staff/security/blocklist/${lifted.id}/lift`,
          s.manager.token,
          { reasonCode: 'resolved' },
        )
        .expect(200);
      const { signed, body } = await o.bundle(
        s.guard,
        s.c,
        await o.enrol(s.guard, s.c),
      );
      const byRef = new Map(body.blocklist.map((x) => [x.ref, x]));
      expect(byRef.get(ban.id)).toEqual({
        ref: ban.id,
        kind: 'ban',
        plate: shortTag(salt(body), 'plate', 'قف3101'),
      });
      expect(byRef.get(watch.id)).toMatchObject({ kind: 'watch' });
      expect(byRef.has(person.id)).toBe(false);
      expect(byRef.has(lifted.id)).toBe(false);
      const text = Buffer.from(signed.body, 'base64url').toString('utf8');
      for (const secret of [
        'Bundle-Banned Person',
        '29001010011223',
        'ق ف 3101',
        'قف3101',
      ])
        expect(text).not.toContain(secret);
    });

    it('live resident credentials as tags; a revoked one is not carried', async () => {
      const qr = await o.residentQr(s.alice);
      const credentialId = qr.split('.')[1];
      const gone = await o.residentQr(s.alice);
      const goneId = gone.split('.')[1];
      await o
        .http('post', `/me/entry-credentials/${goneId}/revoke`, s.alice.token)
        .expect(204);
      const { body } = await o.bundle(
        s.guard,
        s.c,
        await o.enrol(s.guard, s.c),
      );
      expect(body.residents).toContain(
        longTag(body.bundleId, 'resident-credential', credentialId),
      );
      expect(body.residents).not.toContain(
        longTag(body.bundleId, 'resident-credential', goneId),
      );
    });

    it('the lockdown holding the gate at download', async () => {
      const t = await o.setUp('Offline Bundles Lockdown');
      const lock = await o.lockdown(t.guard, {
        scope: 'gate',
        gateId: t.guard.gateId,
      });
      const { body } = await o.bundle(
        t.guard,
        t.c,
        await o.enrol(t.guard, t.c),
      );
      expect(body.lockdown).toEqual({ scope: 'gate', since: lock.startedAt });
      await o.endLockdownRaw(t.manager, lock.id).expect(200);
    });
  });

  describe('refused', () => {
    it('off duty: NO_OPEN_SHIFT; another compound’s or an unknown device: not found', async () => {
      const off = await o.guard(s.c);
      const d = await o.enrol(off, s.c);
      const offRes = await o.bundleRaw(off, s.c, d);
      expect([offRes.status, code(offRes)]).toEqual([403, 'NO_OPEN_SHIFT']);
      const unknown = await o.bundleRaw(s.guard, s.c, newDevice());
      expect([unknown.status, code(unknown)]).toEqual([
        404,
        'GATE_DEVICE_NOT_FOUND',
      ]);
      const b = await o.setUp('Offline Bundles Elsewhere');
      const theirs = await o.enrol(b.guard, b.c);
      const foreign = await o.bundleRaw(s.guard, s.c, theirs);
      expect([foreign.status, code(foreign)]).toEqual([
        404,
        'GATE_DEVICE_NOT_FOUND',
      ]);
    });

    it('a revoked device: GATE_DEVICE_REVOKED, and no bundle', async () => {
      const d = await o.enrol(s.guard, s.c);
      await o.revokeRaw(s.manager, d.id).expect(200);
      const res = await o.bundleRaw(s.guard, s.c, d);
      expect([res.status, code(res)]).toEqual([403, 'GATE_DEVICE_REVOKED']);
      expect((await o.deviceRow(s.c, d.id))!.bundleVersion).toBe(0);
    });

    it('signed by another key, or saying something else: refused, by why', async () => {
      const d = await o.enrol(s.guard, s.c);
      const other = await o.bundleRaw(s.guard, s.c, d, {}, newDevice());
      expect([other.status, code(other)]).toEqual([
        422,
        'GATE_DEVICE_SIGNATURE_INVALID',
      ]);
      for (const [over, why] of [
        [{ purpose: 'heartbeat' }, 'purpose'],
        [{ tenantId: '01a102b6-6253-74a0-92b1-96e7c9d52601' }, 'tenant'],
        [{ deviceId: newDevice().id }, 'device'],
        [{ sentAt: 'yesterday' }, 'sent_at'],
        // Now, but without its offset: no instant (ADR 0025).
        [{ sentAt: dbClock().toISOString().replace('Z', '') }, 'sent_at'],
        [
          {
            sentAt: new Date(
              dbClock().getTime() - ENVELOPE_WINDOW_MS - HOUR,
            ).toISOString(),
          },
          'sent_at',
        ],
        [
          {
            sentAt: new Date(
              dbClock().getTime() + ENVELOPE_WINDOW_MS + HOUR,
            ).toISOString(),
          },
          'sent_at',
        ],
      ] as const) {
        const res = await o.bundleRaw(s.guard, s.c, d, over);
        expect([res.status, code(res), reason(res)]).toEqual([
          422,
          'GATE_DEVICE_ENVELOPE_INVALID',
          why,
        ]);
      }
      // A payload that is no JSON object, signed as sent.
      const raw = Buffer.from('[1,2]').toString('base64url');
      const signed = envelope(d, s.c.tenantId, 'bundle');
      const res = await o.http('post', '/gate/offline/bundles', s.guard.token, {
        ...signed,
        payload: raw,
        signature: signAs(d, `jiwar:gate-device:v1\n${raw}`),
      });
      expect([res.status, reason(res)]).toEqual([422, 'payload']);
      expect((await o.deviceRow(s.c, d.id))!.bundleVersion).toBe(0);
    });

    it('the same envelope twice: GATE_DEVICE_ENVELOPE_REPLAYED', async () => {
      const d = await o.enrol(s.guard, s.c);
      const once = envelope(d, s.c.tenantId, 'bundle');
      await o
        .http('post', '/gate/offline/bundles', s.guard.token, once)
        .expect(200);
      const again = await o.http(
        'post',
        '/gate/offline/bundles',
        s.guard.token,
        once,
      );
      expect([again.status, code(again)]).toEqual([
        409,
        'GATE_DEVICE_ENVELOPE_REPLAYED',
      ]);
      expect((await o.deviceRow(s.c, d.id))!.bundleVersion).toBe(1);
    });

    it(`at most ${BUNDLE_RATE_PER_MINUTE} a minute per device`, async () => {
      const d = await o.enrol(s.guard, s.c);
      for (let i = 0; i < BUNDLE_RATE_PER_MINUTE; i++)
        await o.bundle(s.guard, s.c, d);
      const res = await o.bundleRaw(s.guard, s.c, d);
      expect([res.status, code(res)]).toEqual([429, 'RATE_LIMITED']);
      expect((await o.deviceRow(s.c, d.id))!.bundleVersion).toBe(
        BUNDLE_RATE_PER_MINUTE,
      );
    });
  });

  describe('the replay guard’s sweep', () => {
    it('forgets an envelope once its receipt and its sentAt are a day old', async () => {
      const d = await o.enrol(s.guard, s.c);
      const now = dbClock().getTime();
      const row = (hex: string, sentAt: number, receivedAt: number) =>
        superuserSql(
          `INSERT INTO gate_device_envelopes
             (tenant_id, device_id, signature_sha256, sent_at, received_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [s.c.tenantId, d.id, hex, new Date(sentAt), new Date(receivedAt)],
        );
      const old = 'a'.repeat(64);
      const ahead = 'b'.repeat(64);
      const fresh = 'c'.repeat(64);
      await row(old, now - 25 * HOUR, now - 25 * HOUR);
      // Received a day ago, but its sentAt says tomorrow: kept.
      await row(ahead, now + 2 * HOUR, now - 25 * HOUR);
      await row(fresh, now - HOUR, now - HOUR);
      await o.sweep(DEVICE_ENVELOPES_SWEEP, dbClock());
      const left = await o.inTx(s.c, (tx) =>
        tx.gateDeviceEnvelope.findMany({
          where: { deviceId: d.id },
          select: { signatureSha256: true },
        }),
      );
      expect(left.map((r) => r.signatureSha256).sort()).toEqual([ahead, fresh]);
    });
  });
});
