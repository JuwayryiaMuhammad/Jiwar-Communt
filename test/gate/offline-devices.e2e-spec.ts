import { enrolMessage } from '../../src/gate/offline/device-envelope';
import { DEVICE_LIMIT } from '../../src/gate/offline/gate-devices.service';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  newDevice,
  offlineHelpers,
  signAs,
  type StaffDeviceBody,
} from '../setup/offline';
import { deviceRow } from '../setup/offline-rows';

/**
 * ADR 0057, guard devices: a guard enrols the phone the gate works offline
 * on, with its Ed25519 public key and the proof that it holds the private
 * key; the management is told and revokes one, once. A device is the
 * compound's; at most DEVICE_LIMIT live ones.
 */
describe('Gate offline — guard devices (ADR 0057)', () => {
  let h: HttpHarness;
  let o: ReturnType<typeof offlineHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof offlineHelpers>['setUp']>>;
  let read: ReturnType<typeof auditReaders>;
  let supervisor: Awaited<ReturnType<typeof o.supervisor>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    o = offlineHelpers(h);
    s = await o.setUp('Offline Devices Court');
    supervisor = await o.supervisor(s.c);
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;

  describe('enrolled', () => {
    it('with its key and a proof; the keepers told, never the guard', async () => {
      const d = newDevice();
      const res = await o.enrolRaw(s.guard, s.c, d, { label: 'Gate 1 phone' });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: d.id,
        status: 'active',
        enrolledAt: expect.any(String) as string,
        serverTime: expect.any(String) as string,
      });
      expect(await o.deviceRow(s.c, d.id)).toMatchObject({
        publicKey: d.publicKey,
        label: 'Gate 1 phone',
        enrolledById: s.guard.id,
        revokedAt: null,
      });
      for (const keeper of [s.manager, supervisor])
        expect(await o.told(s.c, keeper.id, d.id)).toEqual([
          { kind: 'gate_device.enrolled', params: {} },
        ]);
      expect(await o.told(s.c, s.guard.id, d.id)).toEqual([]);
      // The audit says a label was given, never which.
      const [row] = await read.tenant(s.c.tenantId, { targetId: d.id });
      expect(row).toMatchObject({
        action: 'gate_device.enrolled',
        metadata: { labelled: true },
      });
      expect(JSON.stringify(row)).not.toContain('Gate 1 phone');
      expect(JSON.stringify(row)).not.toContain(d.publicKey);
    });

    it('the same id and key again answer the same, once', async () => {
      const d = await o.enrol(s.guard, s.c);
      const first = await o.deviceRow(s.c, d.id);
      const again = await o.enrolRaw(s.guard, s.c, d);
      expect(again.status).toBe(201);
      expect(again.body).toMatchObject({
        id: d.id,
        enrolledAt: first!.enrolledAt.toISOString(),
      });
      expect(
        await read.tenant(s.c.tenantId, {
          targetId: d.id,
          action: 'gate_device.enrolled',
        }),
      ).toHaveLength(1);
      expect(await o.told(s.c, s.manager.id, d.id)).toHaveLength(1);
    });

    it('another key under the id: GATE_DEVICE_EXISTS; the key under another id: the same phone', async () => {
      const d = await o.enrol(s.guard, s.c);
      const other = newDevice();
      const res = await o.enrolRaw(s.guard, s.c, { ...other, id: d.id });
      expect([res.status, code(res)]).toEqual([409, 'GATE_DEVICE_EXISTS']);
      const twin = await o.enrolRaw(s.guard, s.c, {
        ...d,
        id: other.id,
      });
      expect(twin.status).toBe(409);
      expect(twin.body).toMatchObject({
        code: 'DUPLICATE_RESOURCE',
        fields: [{ field: 'publicKey', code: 'DUPLICATE_VALUE' }],
      });
      expect(await o.deviceRow(s.c, other.id)).toBeNull();
    });

    it('a proof by another key, or for another compound, enrols nothing', async () => {
      const d = newDevice();
      const stranger = newDevice();
      const byOther = await o.enrolRaw(s.guard, s.c, d, {
        proof: signAs(stranger, enrolMessage(s.c.tenantId, d.id, d.publicKey)),
      });
      expect([byOther.status, code(byOther)]).toEqual([
        422,
        'GATE_DEVICE_SIGNATURE_INVALID',
      ]);
      const elsewhere = await o.enrolRaw(s.guard, s.c, d, {
        proof: signAs(
          d,
          enrolMessage(
            '01a102b6-6253-74a0-92b1-96e7c9d52601',
            d.id,
            d.publicKey,
          ),
        ),
      });
      expect([elsewhere.status, code(elsewhere)]).toEqual([
        422,
        'GATE_DEVICE_SIGNATURE_INVALID',
      ]);
      expect(await o.deviceRow(s.c, d.id)).toBeNull();
    });

    it('a key that is not an Ed25519 point is a field error', async () => {
      const d = newDevice();
      const res = await o.enrolRaw(s.guard, s.c, d, {
        publicKey: 'x'.repeat(42),
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        fields: [expect.objectContaining({ field: 'publicKey' })],
      });
    });

    it('at most DEVICE_LIMIT live devices; a revoked one does not count', async () => {
      const c = (await o.setUp('Offline Devices Limit')).c;
      const guard = await o.guardOnDuty(c);
      const manager = await o.who(c, c.managerId, 'manager');
      await o.inTx(c, async (tx) => {
        for (let i = 0; i < DEVICE_LIMIT - 1; i++)
          await deviceRow(tx, { tenantId: c.tenantId, enrolledById: guard.id });
      });
      const last = await o.enrol(guard, c);
      const over = await o.enrolRaw(guard, c, newDevice());
      expect([over.status, code(over), over.body]).toEqual([
        409,
        'GATE_DEVICE_LIMIT_REACHED',
        expect.objectContaining({ params: { max: DEVICE_LIMIT } }),
      ]);
      await o.revokeRaw(manager, last.id, 'replaced').expect(200);
      await o.enrol(guard, c);
    });
  });

  describe('revoked', () => {
    it('once, by the management, with a code; audited by the code alone', async () => {
      const d = await o.enrol(s.guard, s.c, undefined, { label: 'Spare' });
      const res = await o.revokeRaw(s.manager, d.id, 'stolen').expect(200);
      expect(res.body as StaffDeviceBody).toMatchObject({
        id: d.id,
        label: 'Spare',
        status: 'revoked',
        enrolledBy: { id: s.guard.id },
        revokedBy: { id: s.manager.id },
        revokeReasonCode: 'stolen',
        revokedAt: expect.any(String) as string,
      });
      const again = await o.revokeRaw(s.manager, d.id, 'lost');
      expect([again.status, code(again)]).toEqual([
        409,
        'GATE_DEVICE_ALREADY_REVOKED',
      ]);
      expect(
        await read.tenant(s.c.tenantId, {
          targetId: d.id,
          action: 'gate_device.revoked',
        }),
      ).toEqual([
        expect.objectContaining({ metadata: { reasonCode: 'stolen' } }),
      ]);
      // Enrolling it again answers what it is: revoked, the same row.
      const back = await o.enrolRaw(s.guard, s.c, d);
      expect([back.status, (back.body as { status: string }).status]).toEqual([
        201,
        'revoked',
      ]);
    });

    it('a retried revoke replays; the supervisor revokes too; a guard may not', async () => {
      const d = await o.enrol(s.guard, s.c);
      const key = { 'Idempotency-Key': `revoke-${d.id}` };
      await o.revokeRaw(supervisor, d.id, 'retired', key).expect(200);
      const replay = await o.revokeRaw(supervisor, d.id, 'retired', key);
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      const other = await o.enrol(s.guard, s.c);
      await o.revokeRaw(s.guard, other.id).expect(403);
    });

    it('a reason outside its list is a field error', async () => {
      const d = await o.enrol(s.guard, s.c);
      const res = await o.revokeRaw(s.manager, d.id, 'misplaced');
      expect(res.status).toBe(400);
      expect((await o.deviceRow(s.c, d.id))!.revokedAt).toBeNull();
    });
  });

  describe('listed', () => {
    it('newest first, by status; another compound’s device is not found', async () => {
      const live = await o.enrol(s.guard, s.c);
      const gone = await o.enrol(s.guard, s.c);
      await o.revokeRaw(s.manager, gone.id).expect(200);
      const list = async (q: string) =>
        (
          (
            await o
              .http('get', `/staff/gate/devices${q}`, s.manager.token)
              .expect(200)
          ).body as { data: StaffDeviceBody[] }
        ).data.map((d) => d.id);
      expect((await list('?status=active')).slice(0, 1)).toEqual([live.id]);
      expect(await list('?status=active')).not.toContain(gone.id);
      expect((await list('?status=revoked'))[0]).toBe(gone.id);
      expect((await list(''))[0]).toBe(gone.id);
      expect(await o.deviceView(s.manager, live.id)).toMatchObject({
        status: 'active',
        revokedBy: null,
      });
      const b = await o.setUp('Offline Devices Elsewhere');
      const res = await o.http(
        'get',
        `/staff/gate/devices/${live.id}`,
        b.manager.token,
      );
      expect([res.status, code(res)]).toEqual([404, 'GATE_DEVICE_NOT_FOUND']);
    });
  });
});
