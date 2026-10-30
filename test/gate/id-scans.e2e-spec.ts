import { ID_SCAN_DRIVER } from '../../src/gate/id-scan/id-scan-driver';
import { ID_SCAN_ORPHAN_SWEEP } from '../../src/gate/id-scan/id-scans.service';
import type { FakeIdScanDriver } from '../../src/gate/id-scan/fake-id-scan-driver';
import { auditReaders } from '../setup/audit';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers, type Who } from '../setup/security-ops';
import { whileShiftEnds } from '../setup/shift-end';

const NUMBER = '29511230106781';
const NAME_EN = 'Scanned Holder Zeta';
const NAME_AR = 'حامل ممسوح زيتا';

interface IdScan {
  documentType: string;
  number: string;
  names: { en: string | null; ar: string | null };
  birthDate: string | null;
  expiresOn: string | null;
  expired: boolean | null;
  nationalId: { valid: boolean; birthDate: string | null } | null;
  matches: { id: string; kind: string }[];
}

/**
 * ADR 0068: a guard's ID scan. On shift at a gate, the vendor reads a
 * document; our checks run on what it read (shape, a national ID's own
 * structure, expiry) and the number meets the blocklist as an ID lookup's
 * does. What was read goes to the guard's device once: no idempotency
 * record, no audit beyond the outcome, no notification, no outbox. The
 * image goes whatever came of it.
 */
const codeOf = (res: { body: unknown }) => (res.body as { code?: string }).code;
const fieldsOf = (res: { body: unknown }) =>
  (res.body as { fields?: unknown }).fields;

describe('Gate — ID scans', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let guard: Who & { gateId: string; shiftId: string };
  let vendor: FakeIdScanDriver;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('ID Scan Court');
    guard = await x.guardOnDuty(s.c);
    vendor = h.moduleRef.get<FakeIdScanDriver>(ID_SCAN_DRIVER);
  }, 120_000);

  afterAll(() => h.close());

  const scanRaw = (imageFileId: string, as: Who = guard) =>
    x.http('post', '/gate/id-scans', as.token, { imageFileId });
  const image = (as: Who = guard) => x.files.ready(as.token, 'gate_id_scan');
  const fileRow = (id: string) =>
    x.inTx(s.c, (tx) => tx.storedFile.findUnique({ where: { id } }));
  const reading = (over: Record<string, unknown> = {}) => ({
    documentType: 'national_id' as const,
    number: NUMBER,
    names: { en: NAME_EN, ar: NAME_AR },
    birthDate: '1995-11-23',
    expiresOn: '2020-01-01',
    ...over,
  });

  it('reads the document, checks it, meets the blocklist; the image is gone; nothing is kept', async () => {
    const started = new Date();
    const entry = await x.block(s.manager, {
      kind: 'watch',
      subject: 'person',
      fullName: 'Listed Person',
      idNumber: NUMBER,
    });
    vendor.script(reading());
    const file = await image();
    const res = await scanRaw(file).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body as IdScan).toEqual({
      documentType: 'national_id',
      number: NUMBER,
      names: { en: NAME_EN, ar: NAME_AR },
      birthDate: '1995-11-23',
      expiresOn: '2020-01-01',
      expired: true,
      nationalId: { valid: true, birthDate: '1995-11-23' },
      matches: [expect.objectContaining({ id: entry.id, kind: 'watch' })],
    });
    expect(await fileRow(file)).toBeNull();
    const [met] = await x.inTx(s.c, (tx) =>
      tx.blocklistMatch.findMany({
        where: { entryId: entry.id, source: 'id_scan' },
      }),
    );
    expect(met).toMatchObject({
      outcome: 'noted',
      shiftId: guard.shiftId,
      actorAccountId: guard.id,
    });
    const [audit] = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'gate.id_scanned',
      targetId: guard.shiftId,
    });
    expect(audit).toMatchObject({ actorId: guard.id });
    expect(audit.metadata).toEqual({
      outcome: 'read',
      documentType: 'national_id',
      matched: true,
    });
    // The trail: nothing read is in an audit row, a notification, an
    // idempotency record or the outbox.
    const rows = await x.inTx(s.c, async (tx) => ({
      audit: await tx.auditLog.findMany({
        where: { occurredAt: { gte: started } },
      }),
      notifications: await tx.notification.findMany({
        where: { createdAt: { gte: started } },
      }),
      keys: await tx.idempotencyKey.findMany({
        where: { createdAt: { gte: started } },
      }),
      outbox: await tx.outboxMessage.findMany({
        where: { createdAt: { gte: started } },
      }),
    }));
    for (const [name, list] of Object.entries(rows)) {
      const text = JSON.stringify(list);
      for (const bad of [NUMBER, NAME_EN, NAME_AR, '1995-11-23'])
        expect([name, bad, text.includes(bad)]).toEqual([name, bad, false]);
    }
  });

  it('a passport is not a national ID; a national ID whose number does not hold says so; no expiry shown is unknown', async () => {
    vendor.script(
      reading({
        documentType: 'passport',
        number: 'a1234567',
        expiresOn: null,
      }),
    );
    expect((await scanRaw(await image()).expect(200)).body).toMatchObject({
      documentType: 'passport',
      number: 'A1234567',
      expired: null,
      nationalId: null,
      matches: [],
    });
    vendor.script(
      reading({ number: '29513230106781', birthDate: '1995-13-23' }),
    );
    expect((await scanRaw(await image()).expect(200)).body).toMatchObject({
      nationalId: { valid: false, birthDate: null },
      birthDate: null,
    });
  });

  it('unreadable: 422, audited as such, the image gone; the vendor down: 503, the image gone', async () => {
    vendor.script(reading({ number: null }));
    const unread = await image();
    expect(codeOf(await scanRaw(unread).expect(422))).toBe(
      'ID_SCAN_UNREADABLE',
    );
    expect(await fileRow(unread)).toBeNull();
    const audits = await auditReaders(h).tenant(s.c.tenantId, {
      action: 'gate.id_scanned',
      targetId: guard.shiftId,
    });
    expect(audits.map((a) => a.metadata)).toContainEqual({
      outcome: 'unreadable',
      documentType: 'national_id',
      matched: false,
    });
    vendor.failNext('timeout');
    const down = await image();
    expect((await scanRaw(down).expect(503)).body).toMatchObject({
      code: 'VENDOR_UNAVAILABLE',
      params: { service: 'id_scan' },
    });
    expect(await fileRow(down)).toBeNull();
  });

  it('only the guard’s own image, only on shift at a gate; one left behind is swept', async () => {
    const other = await x.guardOnDuty(s.c);
    const theirs = await image(other);
    expect(fieldsOf(await scanRaw(theirs).expect(400))).toEqual([
      { field: 'imageFileId', code: 'FILE_NOT_AVAILABLE' },
    ]);
    const zoneGuard = await x.guardInZone(
      s.c,
      (await x.places(s.alice)).phase_b.id,
    );
    expect(
      codeOf(await scanRaw(await image(zoneGuard), zoneGuard).expect(403)),
    ).toBe('SHIFT_NOT_AT_GATE');
    // Never sent: the sweep takes it after an hour.
    await x.sweep(ID_SCAN_ORPHAN_SWEEP, new Date(Date.now() + 2 * 3_600_000));
    expect(await fileRow(theirs)).toMatchObject({
      deletedAt: expect.any(Date) as Date,
    });
  });

  describe('races', () => {
    it('a shift that ends while the vendor reads records nothing, and the image still goes', async () => {
      const leaving = await x.guardOnDuty(s.c);
      await x.block(s.manager, {
        subject: 'person',
        fullName: 'Race Holder',
        idNumber: '29001011277001',
      });
      vendor.script(reading({ number: '29001011277001' }));
      const file = await image(leaving);
      const before = vendor.calls;
      vendor.hold();
      const pending = scanRaw(file, leaving).then((r) => r);
      for (let i = 0; i < 200 && vendor.calls === before; i++)
        await new Promise((r) => setTimeout(r, 25));
      await x.endRaw(leaving).expect(200);
      vendor.release();
      const res = await pending;
      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe('NO_OPEN_SHIFT');
      expect(
        await x.inTx(s.c, (tx) =>
          tx.blocklistMatch.count({ where: { shiftId: leaving.shiftId } }),
        ),
      ).toBe(0);
      expect(await fileRow(file)).toBeNull();
    });

    it('a shift that ends before the scan refuses it, and the image stays its own', async () => {
      const leaving = await x.guardOnDuty(s.c);
      const file = await image(leaving);
      const res = await whileShiftEnds(leaving.shiftId, () =>
        scanRaw(file, leaving),
      );
      expect(res.status).toBe(403);
      expect(await fileRow(file)).toMatchObject({ deletedAt: null });
    });
  });
});
