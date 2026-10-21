import { contentSha256 } from '../../src/gate/incidents/incident-signature-content';
import { dbClock } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers, type Who } from '../setup/security-ops';
import { whileShiftEnds } from '../setup/shift-end';

const ROUNDS = 5;

/**
 * ADR 0056, a signature against the close. Both take the incident FOR
 * UPDATE: the signature hashes the report either before the close or
 * after it, never halfway. The author's content is the same either way;
 * the reviewer's is superseded exactly when it was signed first.
 *
 * The author's signature while their shift ends: it takes the account,
 * then the shift, FOR SHARE (ADR 0056's lock order), so it waits for the
 * end and is refused, never signed by a guard off duty.
 */
describe('Incident signatures — races', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;
  let guard: Who & { gateId: string };
  let reviewer: Who;
  let closer: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Signature Race Court');
    guard = await x.guardOnDuty(s.c);
    reviewer = await x.staff(s.c, ['incidents.manage']);
    closer = await x.staff(s.c, ['incidents.manage']);
  }, 180_000);

  afterAll(() => h.close());

  async function round() {
    const incident = (
      await x
        .http('post', '/gate/incidents', guard.token, {
          type: 'hazard',
          severity: 'low',
          unitCode: s.home.code,
          occurredAt: new Date(dbClock().getTime() - 600_000).toISOString(),
          description: 'Race words',
        })
        .expect(201)
    ).body as { id: string };
    const material = async () =>
      x.inTx(s.c, async (tx) => ({
        incident: await tx.incident.findUniqueOrThrow({
          where: { id: incident.id },
        }),
        photoFileIds: [],
        mediaFileIds: [],
        evidenceIds: [],
      }));
    const before = await material();
    const [authorFile, reviewerFile] = await Promise.all([
      x.photo(guard, 'incident_signature'),
      x.photo(reviewer, 'incident_signature'),
    ]);
    const [author, review, closed] = await Promise.all([
      x.http('post', `/gate/incidents/${incident.id}/signatures`, guard.token, {
        role: 'author',
        fileId: authorFile,
      }),
      x.http(
        'post',
        `/staff/security/incidents/${incident.id}/signatures`,
        reviewer.token,
        { role: 'reviewer', fileId: reviewerFile },
      ),
      x.http(
        'post',
        `/staff/security/incidents/${incident.id}/close`,
        closer.token,
        { reasonCode: 'resolved', note: 'Race close' },
      ),
    ]);
    expect([author.status, review.status, closed.status]).toEqual([
      201, 201, 200,
    ]);
    const after = await material();
    const listed = (
      (
        await x
          .http(
            'get',
            `/staff/security/incidents/${incident.id}/signatures`,
            closer.token,
          )
          .expect(200)
      ).body as {
        data: { role: string; contentSha256: string; superseded: boolean }[];
      }
    ).data;
    const a = listed.find((l) => l.role === 'author')!;
    const r = listed.find((l) => l.role === 'reviewer')!;
    // The author's content does not move with a close.
    expect(contentSha256('author', after)).toBe(
      contentSha256('author', before),
    );
    expect(a).toMatchObject({
      contentSha256: contentSha256('author', after),
      superseded: false,
    });
    // The reviewer signed what was there before the close, or after it.
    const open = contentSha256('reviewer', before);
    const done = contentSha256('reviewer', after);
    expect([open, done]).toContain(r.contentSha256);
    expect(r.superseded).toBe(r.contentSha256 === open);
  }

  it('a signature and a close at once: hashed before or after, never between (×5)', async () => {
    for (let i = 0; i < ROUNDS; i++) await round();
  });

  it('the author’s signature while their shift ends: it waits for the end, then is refused', async () => {
    const leaving = await x.guardAt(s.c, guard.gateId);
    const incident = (
      await x
        .http('post', '/gate/incidents', leaving.token, {
          type: 'hazard',
          severity: 'low',
          unitCode: s.home.code,
          occurredAt: new Date(dbClock().getTime() - 600_000).toISOString(),
          description: 'Signed at the end of a shift',
        })
        .expect(201)
    ).body as { id: string };
    const fileId = await x.photo(leaving, 'incident_signature');
    const res = await whileShiftEnds(leaving.shiftId, () =>
      x.http(
        'post',
        `/gate/incidents/${incident.id}/signatures`,
        leaving.token,
        {
          role: 'author',
          fileId,
        },
      ),
    );
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('NO_OPEN_SHIFT');
    expect(
      await x.inTx(s.c, (tx) =>
        tx.incidentSignature.count({ where: { incidentId: incident.id } }),
      ),
    ).toBe(0);
  });
});
