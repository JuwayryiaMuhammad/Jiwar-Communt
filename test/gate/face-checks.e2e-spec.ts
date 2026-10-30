import { FACE_DRIVER } from '../../src/gate/face/face-driver';
import { FACE_PROBE_SWEEP } from '../../src/gate/face/face-checks.service';
import { FACE_ENROLLMENT_SWEEP } from '../../src/gate/face/face-enrollments';
import type { FakeFaceDriver } from '../../src/gate/face/fake-face-driver';
import { BLOCKLIST_SWEEP } from '../../src/gate/blocklist/blocklist.service';
import { auditReaders } from '../setup/audit';
import { SAMPLE } from '../setup/files';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';
import { securityOpsHelpers, type Who } from '../setup/security-ops';

// eslint-disable-next-line no-restricted-syntax -- a real 24 h: the probe's retention is checked against now, in ms
const DAY = 86_400_000;

interface FaceCheck {
  id: string;
  outcome: string;
  checkedAt: string | null;
  matches: { id: string; kind: string; fullName: string | null }[];
}

/** A PNG of its own bytes: the fake vendor matches a face by its bytes. */
const face = (n: number) =>
  Buffer.concat([SAMPLE['image/png'].subarray(0, 8), Buffer.alloc(40, n)]);

/**
 * ADR 0068: face checks at the gate, advisory only. The compound turns them
 * on, with its word that a notice is posted; the blocklist's live faces are
 * enrolled at the vendor by a sweep, and removed when an entry is lifted,
 * purged or its photo changes, or the switch goes off. A guard on shift at
 * a gate checks a face: the live entries it may be, recorded as met and
 * told to the keepers — never a score, never a refusal by itself.
 */
const codeOf = (res: { body: unknown }) => (res.body as { code?: string }).code;
const fieldsOf = (res: { body: unknown }) =>
  (res.body as { fields?: unknown }).fields;

describe('Gate — face checks', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let guard: Who & { gateId: string; shiftId: string };
  let vendor: FakeFaceDriver;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Face Check Court');
    guard = await x.guardOnDuty(s.c);
    vendor = h.moduleRef.get<FakeFaceDriver>(FACE_DRIVER);
  }, 120_000);

  afterAll(() => h.close());

  const audit = (action: string, targetId: string) =>
    auditReaders(h).tenant(s.c.tenantId, { action, targetId });
  const enrolSweep = () => x.sweep(FACE_ENROLLMENT_SWEEP);
  const settings = (body: Record<string, unknown>) =>
    x.http('patch', '/staff/gate/settings', s.manager.token, body);
  /** A finalized file of these bytes, of the caller's. */
  async function image(as: Who, purpose: string, n: number) {
    const id = await x.files.uploaded(as.token, purpose, 'image/png', face(n));
    await x.files.finalize(as.token, id).expect(200);
    return id;
  }
  async function person(n: number, kind = 'ban') {
    return x.block(s.manager, {
      kind,
      subject: 'person',
      fullName: `Face Person ${n}`,
      idNumber: `290010112${String(1000 + n).padStart(5, '0')}`,
      photoFileId: await image(s.manager, 'blocklist_photo', n),
    });
  }
  const checkRaw = (
    photoFileId: string,
    as: Who = guard,
    headers: Record<string, string> = {},
  ) => x.http('post', '/gate/face-checks', as.token, { photoFileId }, headers);
  const check = async (n: number) =>
    (await checkRaw(await image(guard, 'gate_face_probe', n)).expect(201))
      .body as FaceCheck;
  const enrolments = (entryId: string) =>
    x.inTx(s.c, (tx) =>
      tx.gateFaceEnrollment.findMany({
        where: { entryId },
        orderBy: { createdAt: 'asc' },
      }),
    );

  it('off until the management turns it on, with its word that the notice is posted', async () => {
    const probe = await image(guard, 'gate_face_probe', 1);
    expect(codeOf(await checkRaw(probe).expect(409))).toBe('FACE_CHECKS_OFF');
    expect(fieldsOf(await settings({ faceChecks: true }).expect(400))).toEqual([
      { field: 'faceChecksNoticePosted', code: 'FIELD_REQUIRED' },
    ]);
    const on = await settings({
      faceChecks: true,
      faceChecksNoticePosted: true,
    }).expect(200);
    expect((on.body as { faceChecks: boolean }).faceChecks).toBe(true);
    const [row] = await audit('gate_settings.changed', s.c.tenantId);
    expect(row.metadata).toEqual({ faceChecksNoticePosted: true });
  });

  it('a live face is enrolled by the sweep, matched by the same face, recorded and told; never a score', async () => {
    const banned = await person(2);
    const [pending] = await enrolments(banned.id);
    expect(pending).toMatchObject({ status: 'pending', templateRef: null });
    await enrolSweep();
    const [enrolled] = await enrolments(banned.id);
    expect(enrolled).toMatchObject({ status: 'enrolled' });
    expect(vendor.templates(s.c.tenantId)).toContain(enrolled.templateRef);
    expect(await audit('face_enrollment.enrolled', enrolled.id)).toHaveLength(
      1,
    );

    const res = await checkRaw(await image(guard, 'gate_face_probe', 2));
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const hit = res.body as FaceCheck;
    expect(hit).toMatchObject({
      outcome: 'possible_match',
      matches: [{ id: banned.id, kind: 'ban', fullName: 'Face Person 2' }],
    });
    expect(JSON.stringify(hit)).not.toMatch(/score|template/i);
    const [met] = await x.inTx(s.c, (tx) =>
      tx.blocklistMatch.findMany({
        where: { subjectType: 'face_check', subjectId: hit.id },
      }),
    );
    expect(met).toMatchObject({
      entryId: banned.id,
      source: 'face',
      outcome: 'noted',
      shiftId: guard.shiftId,
      gateId: guard.gateId,
    });
    expect(
      await x.inTx(s.c, (tx) =>
        tx.notification.count({
          where: {
            accountId: s.manager.id,
            kind: 'blocklist.ban_matched',
            targetId: banned.id,
          },
        }),
      ),
    ).toBe(1);
    const [made] = await audit('face_check.made', hit.id);
    expect(made).toMatchObject({ actorId: guard.id });
    expect(made.metadata).toEqual({
      shiftId: guard.shiftId,
      outcome: 'possible_match',
      entryIds: [banned.id],
    });
    expect(leakText(made)).not.toMatch(/Face Person|fake-tpl/);
    // Read back by the guard who made it, and nobody else: the same check,
    // its photos' links signed afresh.
    const unlinked = (c: unknown) =>
      JSON.stringify(c, (k, v: unknown) =>
        k === 'url' || k === 'expiresAt' ? undefined : v,
      );
    expect(
      unlinked(
        (
          await x
            .http('get', `/gate/face-checks/${hit.id}`, guard.token)
            .expect(200)
        ).body,
      ),
    ).toBe(unlinked(hit));
    const other = await x.guardOnDuty(s.c);
    await x.http('get', `/gate/face-checks/${hit.id}`, other.token).expect(404);
  });

  it('another face meets nobody; a vendor that fails is unavailable, and the guard goes on by hand', async () => {
    expect(await check(3)).toMatchObject({ outcome: 'no_match', matches: [] });
    vendor.failNext('timeout');
    const down = await check(3);
    expect(down).toMatchObject({ outcome: 'unavailable', matches: [] });
    expect((await audit('face_check.made', down.id))[0].metadata).toMatchObject(
      { outcome: 'unavailable', entryIds: [] },
    );
  });

  it('only on shift at a gate, only the guard’s own probe; the same key answers the same check', async () => {
    const zoneGuard = await x.guardInZone(
      s.c,
      (await x.places(s.alice)).phase_b.id,
    );
    const theirs = await image(zoneGuard, 'gate_face_probe', 4);
    expect(codeOf(await checkRaw(theirs, zoneGuard).expect(403))).toBe(
      'SHIFT_NOT_AT_GATE',
    );
    expect(fieldsOf(await checkRaw(theirs).expect(400))).toEqual([
      { field: 'photoFileId', code: 'FILE_NOT_AVAILABLE' },
    ]);
    const probe = await image(guard, 'gate_face_probe', 4);
    const key = { 'Idempotency-Key': `face-${Date.now()}` };
    const one = (await checkRaw(probe, guard, key).expect(201))
      .body as FaceCheck;
    const again = (await checkRaw(probe, guard, key).expect(201))
      .body as FaceCheck;
    expect(again).toEqual(one);
  });

  it('a lifted entry’s face is removed, and so is a replaced photo’s; the switch off removes them all', async () => {
    const watched = await person(5, 'watch');
    await enrolSweep();
    const [first] = await enrolments(watched.id);
    // A new photo: the old template goes, the new one comes.
    await x
      .http(
        'patch',
        `/staff/security/blocklist/${watched.id}`,
        s.manager.token,
        {
          photoFileId: await image(s.manager, 'blocklist_photo', 6),
        },
      )
      .expect(200);
    await enrolSweep();
    const [old, next] = await enrolments(watched.id);
    expect(old).toMatchObject({
      id: first.id,
      status: 'removed',
      templateRef: null,
    });
    expect(next).toMatchObject({ status: 'enrolled' });
    expect(vendor.templates(s.c.tenantId)).not.toContain(first.templateRef);
    expect((await check(5)).outcome).toBe('no_match');
    expect((await check(6)).outcome).toBe('possible_match');
    // Lifted: removed.
    await x
      .http(
        'post',
        `/staff/security/blocklist/${watched.id}/lift`,
        s.manager.token,
        {
          reasonCode: 'resolved',
        },
      )
      .expect(200);
    await enrolSweep();
    expect((await enrolments(watched.id)).map((e) => e.status)).toEqual([
      'removed',
      'removed',
    ]);
    expect(vendor.templates(s.c.tenantId)).not.toContain(next.templateRef);
    // The switch off: every face goes; on again, the live ones come back.
    const kept = await person(7);
    await enrolSweep();
    await settings({ faceChecks: false }).expect(200);
    await enrolSweep();
    expect(vendor.templates(s.c.tenantId)).toEqual([]);
    await settings({ faceChecks: true, faceChecksNoticePosted: true }).expect(
      200,
    );
    await enrolSweep();
    expect((await enrolments(kept.id)).map((e) => e.status)).toEqual([
      'removed',
      'enrolled',
    ]);
  });

  it('a purged entry leaves no template; a probe goes after a day, or 30 after a match', async () => {
    const gone = await person(8);
    await enrolSweep();
    await x
      .http(
        'post',
        `/staff/security/blocklist/${gone.id}/lift`,
        s.manager.token,
        {
          reasonCode: 'resolved',
        },
      )
      .expect(200);
    // eslint-disable-next-line test-clock/day-multiple -- a real 31 × 24 h: past the blocklist's purge window, checked against now in ms
    await x.sweep(BLOCKLIST_SWEEP, new Date(Date.now() + 31 * DAY));
    await enrolSweep();
    const [e] = await enrolments(gone.id);
    expect(e).toMatchObject({ status: 'removed', templateRef: null });
    expect(
      vendor.templates(s.c.tenantId).filter((t) => t.includes(e.id)),
    ).toEqual([]);

    const matched = await person(9);
    await enrolSweep();
    const hit = await check(9);
    const miss = await check(10);
    const probeOf = (id: string) =>
      x.inTx(s.c, (tx) =>
        tx.gateFaceCheck.findUniqueOrThrow({ where: { id } }),
      );
    const missFile = (await probeOf(miss.id)).probeFileId!;
    // eslint-disable-next-line test-clock/day-multiple -- a real 2 × 24 h: past a probe's day (PROBE_DAYS × DAY_MS), checked against now in ms
    await x.sweep(FACE_PROBE_SWEEP, new Date(Date.now() + 2 * DAY));
    expect(await probeOf(miss.id)).toMatchObject({ probeFileId: null });
    expect((await probeOf(hit.id)).probeFileId).not.toBeNull();
    expect(
      await x.inTx(s.c, (tx) =>
        tx.storedFile.findUnique({ where: { id: missFile } }),
      ),
    ).toMatchObject({ deletedAt: expect.any(Date) as Date });
    // eslint-disable-next-line test-clock/day-multiple -- a real 31 × 24 h: past a matched probe's 30 days (MATCHED_PROBE_DAYS × DAY_MS), checked against now in ms
    await x.sweep(FACE_PROBE_SWEEP, new Date(Date.now() + 31 * DAY));
    expect(await probeOf(hit.id)).toMatchObject({
      probeFileId: null,
      outcome: 'possible_match',
    });
    expect(matched.id).toBeDefined();
  });
});
