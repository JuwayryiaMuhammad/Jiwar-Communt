import { gateCompletionHelpers } from '../setup/gate-completion';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { whileShiftEnds } from '../setup/shift-end';

const ROUNDS = 5;

/**
 * ADR 0056, a photo past its 30 days kept by an incident while the purge
 * runs: the link holds the photo's row FOR SHARE, the purge takes it FOR
 * UPDATE SKIP LOCKED. Either the link comes first and the photo stays (the
 * purge skips it, then finds it kept), or the purge comes first and the
 * link finds no photo; never evidence that names a deleted photo.
 *
 * A guard's link while their shift ends: the link takes the account, then
 * the shift, FOR SHARE (ADR 0056's lock order), so it waits for the end
 * and is refused, never kept by a guard off duty.
 */
describe('Gate — a visitor’s photo kept while it is purged (ADR 0056)', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof gateCompletionHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof gateCompletionHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = gateCompletionHelpers(h);
    s = await g.setUp('Visitor Photo Race Court');
  }, 180_000);

  afterAll(() => h.close());

  it('kept, or purged: one of the two', async () => {
    const incidentId = await g.incident(s.guard, s.unitCode);
    for (let round = 0; round < ROUNDS; round++) {
      const p = await g.pass(s.alice, s.home.id);
      const photoFileId = await g.photo(s.guard, 'visitor_photo');
      const entryId = await g.enter(s.guard, 'visitor_pass', p.id, {
        photoFileId,
      });
      await g.photoDue(entryId);
      const [linked] = await Promise.all([
        g.http(
          'post',
          `/staff/security/incidents/${incidentId}/evidence`,
          s.manager.token,
          { kind: 'visitor_photo', entryId },
        ),
        g.sweepPhotos(),
      ]);
      // A purge that skipped it: the next run finds it kept.
      await g.sweepPhotos();
      const photo = await g.inTx(s.c, (tx) =>
        tx.gateEntryPhoto.findFirst({ where: { entryId } }),
      );
      const evidence = await g.inTx(s.c, (tx) =>
        tx.incidentEvidence.count({ where: { entryId } }),
      );
      if (linked.status === 201) {
        expect(photo).not.toBeNull();
        expect(evidence).toBe(1);
      } else {
        expect((linked.body as { code: string }).code).toBe(
          'ENTRY_PHOTO_NOT_FOUND',
        );
        expect(photo).toBeNull();
        expect(evidence).toBe(0);
      }
    }
  });

  it('a guard’s link while their shift ends: it waits for the end, then is refused', async () => {
    const leaving = await g.guardAt(s.c, s.guard.gateId);
    const incidentId = await g.incident(leaving, s.unitCode);
    const p = await g.pass(s.alice, s.home.id);
    const photoFileId = await g.photo(s.guard, 'visitor_photo');
    const entryId = await g.enter(s.guard, 'visitor_pass', p.id, {
      photoFileId,
    });
    const res = await whileShiftEnds(leaving.shiftId, () =>
      g.http('post', `/gate/incidents/${incidentId}/evidence`, leaving.token, {
        kind: 'visitor_photo',
        entryId,
      }),
    );
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('NO_OPEN_SHIFT');
    expect(
      await g.inTx(s.c, (tx) =>
        tx.incidentEvidence.count({ where: { entryId } }),
      ),
    ).toBe(0);
  });
});
