import { FACE_DRIVER } from '../../src/gate/face/face-driver';
import { FACE_ENROLLMENT_SWEEP } from '../../src/gate/face/face-enrollments';
import type { FakeFaceDriver } from '../../src/gate/face/fake-face-driver';
import { SAMPLE } from '../setup/files';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers, type Who } from '../setup/security-ops';
import { whileShiftEnds } from '../setup/shift-end';

const face = (n: number) =>
  Buffer.concat([SAMPLE['image/png'].subarray(0, 8), Buffer.alloc(40, n)]);

/**
 * ADR 0068, the face checks' races. A check is two transactions around the
 * vendor: a shift that ends before the first refuses it, one that ends in
 * between leaves it unanswered and nothing met. The gallery's sweep calls
 * the vendor on a lease: a lift while an enrolment is in flight leaves no
 * template. A probe is one check's.
 */
describe('Gate — face checks (races)', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let vendor: FakeFaceDriver;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Face Race Court');
    vendor = h.moduleRef.get<FakeFaceDriver>(FACE_DRIVER);
    await x
      .http('patch', '/staff/gate/settings', s.manager.token, {
        faceChecks: true,
        faceChecksNoticePosted: true,
      })
      .expect(200);
  }, 120_000);

  afterAll(() => h.close());

  async function image(as: Who, purpose: string, n: number) {
    const id = await x.files.uploaded(as.token, purpose, 'image/png', face(n));
    await x.files.finalize(as.token, id).expect(200);
    return id;
  }
  /** Until the vendor was asked `op` (the call is then held). */
  async function asked(op: string, before: number) {
    for (let i = 0; i < 200; i++) {
      if (vendor.calls.slice(before).some((c) => c.op === op)) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`the vendor was never asked to ${op}`);
  }
  const check = (as: Who, photoFileId: string) =>
    x.http('post', '/gate/face-checks', as.token, { photoFileId });

  it('a shift that ends before the check refuses it: no check, nothing met', async () => {
    const guard = await x.guardOnDuty(s.c);
    const probe = await image(guard, 'gate_face_probe', 1);
    const res = await whileShiftEnds(guard.shiftId, () => check(guard, probe));
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('NO_OPEN_SHIFT');
    expect(
      await x.inTx(s.c, (tx) =>
        tx.gateFaceCheck.count({ where: { shiftId: guard.shiftId } }),
      ),
    ).toBe(0);
  });

  it('a shift that ends while the vendor searches leaves the check unanswered and nothing met', async () => {
    await x.block(s.manager, {
      subject: 'person',
      fullName: 'Race Person',
      idNumber: '29001011299001',
      photoFileId: await image(s.manager, 'blocklist_photo', 2),
    });
    await x.sweep(FACE_ENROLLMENT_SWEEP);
    const guard = await x.guardOnDuty(s.c);
    const probe = await image(guard, 'gate_face_probe', 2);
    const before = vendor.calls.length;
    vendor.hold();
    const pending = check(guard, probe).then((r) => r);
    await asked('search', before);
    await x.endRaw(guard).expect(200);
    vendor.release();
    const res = await pending;
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('NO_OPEN_SHIFT');
    const [row] = await x.inTx(s.c, (tx) =>
      tx.gateFaceCheck.findMany({ where: { shiftId: guard.shiftId } }),
    );
    expect(row).toMatchObject({ outcome: null, matches: null });
    expect(
      await x.inTx(s.c, (tx) =>
        tx.blocklistMatch.count({ where: { shiftId: guard.shiftId } }),
      ),
    ).toBe(0);
  });

  it('a lift while the face enrols leaves no template at the vendor', async () => {
    const entry = await x.block(s.manager, {
      kind: 'watch',
      subject: 'person',
      fullName: 'Lifted Person',
      idNumber: '29001011299002',
      photoFileId: await image(s.manager, 'blocklist_photo', 3),
    });
    const before = vendor.calls.length;
    vendor.hold();
    const sweeping = x.sweep(FACE_ENROLLMENT_SWEEP);
    await asked('enroll', before);
    await x
      .http(
        'post',
        `/staff/security/blocklist/${entry.id}/lift`,
        s.manager.token,
        {
          reasonCode: 'resolved',
        },
      )
      .expect(200);
    vendor.release();
    await sweeping;
    const [mid] = await x.inTx(s.c, (tx) =>
      tx.gateFaceEnrollment.findMany({ where: { entryId: entry.id } }),
    );
    expect(mid).toMatchObject({ status: 'removing' });
    expect(mid.templateRef).not.toBeNull();
    await x.sweep(FACE_ENROLLMENT_SWEEP);
    const [done] = await x.inTx(s.c, (tx) =>
      tx.gateFaceEnrollment.findMany({ where: { entryId: entry.id } }),
    );
    expect(done).toMatchObject({ status: 'removed', templateRef: null });
    expect(vendor.templates(s.c.tenantId)).not.toContain(mid.templateRef);
  });

  it('the same probe sent twice at once is one check', async () => {
    const guard = await x.guardOnDuty(s.c);
    const probe = await image(guard, 'gate_face_probe', 4);
    const both = await Promise.all([check(guard, probe), check(guard, probe)]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(
      await x.inTx(s.c, (tx) =>
        tx.gateFaceCheck.count({ where: { probeFileId: probe } }),
      ),
    ).toBe(1);
  });
});
