import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { FACE_ENROLLMENT_SWEEP } from '../../src/gate/face/face-enrollments';
import { auditReaders } from '../setup/audit';
import { GUARD_VENDORS_COVERAGE } from '../setup/audit-coverage-split';
import { SAMPLE } from '../setup/files';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { leakText } from '../setup/leak-text';
import { securityOpsHelpers, type Who } from '../setup/security-ops';

const NAME = 'AUDIT-g8-name';

/**
 * One scenario per entry of the guard vendor adapters' catalog (ADR 0014,
 * 0068): actor, target and metadata — ids, codes and counts; never a
 * face, a template, a score, a document's number or a name.
 */
const covered = new Set<string>();

describe('Audit coverage — guard vendor adapters', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let guard: Who & { gateId: string; shiftId: string };

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    read = auditReaders(h);
    s = await x.setUp('G8 Audit Court');
    guard = await x.guardOnDuty(s.c);
  }, 120_000);

  afterAll(() => h.close());

  async function single(action: string, targetId: string) {
    const rows = await read.tenant(s.c.tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    return rows[0];
  }
  async function image(as: Who, purpose: string, n: number) {
    const id = await x.files.uploaded(
      as.token,
      purpose,
      'image/png',
      Buffer.concat([SAMPLE['image/png'].subarray(0, 8), Buffer.alloc(40, n)]),
    );
    await x.files.finalize(as.token, id).expect(200);
    return id;
  }

  describe('face checks', () => {
    it('face_enrollment.enrolled and .removed — the entry; face_check.made — the shift, the outcome, the entries', async () => {
      await x
        .http('patch', '/staff/gate/settings', s.manager.token, {
          faceChecks: true,
          faceChecksNoticePosted: true,
        })
        .expect(200);
      const entry = await x.block(s.manager, {
        subject: 'person',
        fullName: NAME,
        idNumber: '29001011288001',
        photoFileId: await image(s.manager, 'blocklist_photo', 1),
      });
      await x.sweep(FACE_ENROLLMENT_SWEEP);
      const [enrolment] = await x.inTx(s.c, (tx) =>
        tx.gateFaceEnrollment.findMany({ where: { entryId: entry.id } }),
      );
      const enrolled = await single('face_enrollment.enrolled', enrolment.id);
      expect(enrolled).toMatchObject({
        actorType: 'system',
        metadata: { entryId: entry.id },
      });

      const check = (
        await x
          .http('post', '/gate/face-checks', guard.token, {
            photoFileId: await image(guard, 'gate_face_probe', 1),
          })
          .expect(201)
      ).body as { id: string };
      const made = await single('face_check.made', check.id);
      expect(made).toMatchObject({
        actorId: guard.id,
        metadata: {
          shiftId: guard.shiftId,
          outcome: 'possible_match',
          entryIds: [entry.id],
        },
      });

      await x
        .http(
          'post',
          `/staff/security/blocklist/${entry.id}/lift`,
          s.manager.token,
          { reasonCode: 'resolved' },
        )
        .expect(200);
      await x.sweep(FACE_ENROLLMENT_SWEEP);
      const removed = await single('face_enrollment.removed', enrolment.id);
      expect(removed.metadata).toEqual({ entryId: entry.id, enrolled: true });
      for (const row of [enrolled, made, removed])
        expect(leakText(row)).not.toMatch(/AUDIT-g8|fake-tpl|score/);
    });
  });

  describe('catalog completeness', () => {
    it('every guard vendor entry has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of GUARD_VENDORS_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...GUARD_VENDORS_COVERAGE].sort());
    });
  });
});
