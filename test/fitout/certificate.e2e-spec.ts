import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { deferred, permitHelpers, type PermitSetUp } from '../setup/permits';

/**
 * The works completion certificate waits for the works' open violations
 * and damage claims (ADR 0074): a pass is refused, WORKS_CERTIFICATE_BLOCKED
 * with both counts, until they are settled, cancelled or withdrawn; the
 * fit-out says what blocks it.
 */
describe('Fit-out — the certificate and what blocks it', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  async function asked(s: PermitSetUp) {
    const permit = await p.works(s.alice, s.home.id);
    await p.approve(s.manager, permit.id);
    const inspection = (
      await p
        .http(
          'post',
          `/permits/${permit.id}/completion-inspection`,
          s.alice.token,
        )
        .expect(201)
    ).body as { id: string };
    return { permitId: permit.id, inspectionId: inspection.id };
  }
  const pass = (s: PermitSetUp, inspectionId: string) =>
    deferred(
      (async () =>
        p.http(
          'post',
          `/staff/permit-inspections/${inspectionId}/decide`,
          s.manager.token,
          {
            outcome: 'passed',
            photoFileIds: [
              await p.files.ready(s.manager.token, 'works_inspection_photo'),
            ],
          },
        ))(),
    );
  const violation = (s: PermitSetUp, permitId: string) =>
    p.http('post', '/staff/violations', s.manager.token, {
      kind: 'contractor_hours',
      permitId,
      occurredOn: day(0),
    });
  const blockedBy = async (s: PermitSetUp, permitId: string) =>
    (
      (
        await p
          .http(
            'get',
            `/staff/unit-permits/${permitId}/fit-out`,
            s.manager.token,
          )
          .expect(200)
      ).body as { certificateBlockedBy: unknown }
    ).certificateBlockedBy;

  it('an open violation blocks it; cancelled, the works pass', async () => {
    const s = await p.setUp('Certificate Violation Court');
    const { permitId, inspectionId } = await asked(s);
    const v = (await violation(s, permitId).expect(201)).body as { id: string };
    expect(await blockedBy(s, permitId)).toEqual({ violations: 1, claims: 0 });
    expect((await pass(s, inspectionId).expect(409)).body).toMatchObject({
      code: 'WORKS_CERTIFICATE_BLOCKED',
      params: { violations: 1, claims: 0 },
    });
    await p
      .http('post', `/staff/violations/${v.id}/cancel`, s.manager.token, {
        reasonCode: 'issued_in_error',
      })
      .expect(200);
    expect(await blockedBy(s, permitId)).toBeNull();
    expect((await pass(s, inspectionId).expect(200)).body).toMatchObject({
      status: 'passed',
    });
  });

  it('an open damage claim blocks it; withdrawn, the works pass', async () => {
    const s = await p.setUp('Certificate Claim Court');
    const { permitId, inspectionId } = await asked(s);
    const made = (
      await p
        .http(
          'post',
          `/staff/unit-permits/${permitId}/damage-claims`,
          s.manager.token,
          {
            reasonCode: 'debris_left',
            description: 'Debris left in the stairwell.',
            amount: '300',
            photoFileIds: [
              await p.files.ready(s.manager.token, 'fitout_photo'),
            ],
          },
        )
        .expect(201)
    ).body as { claims: { id: string }[] };
    expect((await pass(s, inspectionId).expect(409)).body).toMatchObject({
      code: 'WORKS_CERTIFICATE_BLOCKED',
      params: { violations: 0, claims: 1 },
    });
    await p
      .http(
        'post',
        `/staff/unit-permits/${permitId}/damage-claims/${made.claims[0].id}/withdraw`,
        s.manager.token,
        { reasonCode: 'repaired_by_unit' },
      )
      .expect(200);
    await pass(s, inspectionId).expect(200);
  });

  it('a violation and a pass at once: the certificate is issued only with no violation open before it', async () => {
    const s = await p.setUp('Certificate Race Court');
    const { permitId, inspectionId } = await asked(s);
    const [issued, passed] = await Promise.all([
      violation(s, permitId),
      pass(s, inspectionId),
    ]);
    expect(issued.status).toBe(201);
    const inspection = await p.v.inTx(s.c, (tx) =>
      tx.permitInspection.findUniqueOrThrow({ where: { id: inspectionId } }),
    );
    if (passed.status === 200) {
      // The pass held the permit's row first: the violation waited for it.
      expect(inspection.status).toBe('passed');
    } else {
      expect((passed.body as { code: string }).code).toBe(
        'WORKS_CERTIFICATE_BLOCKED',
      );
      expect(inspection.status).toBe('asked');
    }
  });
});
