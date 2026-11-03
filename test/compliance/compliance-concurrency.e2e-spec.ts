import { complianceHelpers } from '../setup/compliance';
import { day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const ROUNDS = 5;

/**
 * ADR 0087, the compliance calendar's races. A completion takes the item
 * FOR UPDATE, then its due day; a partial unique index keeps one open due
 * day an item behind the lock. So two completions of one due day: one
 * records it and makes the next, the other finds it done; never two next
 * due days. A retirement against a completion meets in the same order.
 */
describe('Compliance — races', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof complianceHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof complianceHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = complianceHelpers(h);
    s = await x.setUp();
  }, 180_000);

  afterAll(() => h.close());

  const m = () => s.manager.token;
  const occurrences = (itemId: string) =>
    x.inTx(s.c, (tx) =>
      tx.complianceOccurrence.findMany({
        where: { itemId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );

  it('R1: two completions of one due day: one 200, one 409; one done, one next open (×5)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const item = await x.create(m(), {
        ownerId: s.tech.id,
        recurrenceMonths: 12,
        firstDueOn: day(10),
      });
      const id = item.current!.id;
      const [a, b] = await Promise.all([
        x.completeRaw(m(), id, { doneOn: day(0), expiresOn: day(300) }),
        x.completeRaw(m(), id, { doneOn: day(0), expiresOn: day(301) }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body).toMatchObject({
        code: 'COMPLIANCE_OCCURRENCE_ENDED',
        params: { status: 'done' },
      });
      const rows = await occurrences(item.id);
      expect(rows.map((r) => r.status).sort()).toEqual(['done', 'open']);
      // The next due day is the winner's expiry, made once.
      expect(rows.find((r) => r.status === 'open')!.dueOn).toEqual(
        rows.find((r) => r.status === 'done')!.expiresOn,
      );
    }
  });

  it('R2: a completion and a retirement at once: one order, never a due day open on a retired item (×5)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const item = await x.create(m(), {
        ownerId: s.tech.id,
        recurrenceMonths: 6,
        firstDueOn: day(10),
      });
      const [done, retired] = await Promise.all([
        x.completeRaw(m(), item.current!.id, { doneOn: day(0) }),
        x.http('post', `/staff/compliance/items/${item.id}/retire`, m(), {
          reasonCode: 'replaced',
        }),
      ]);
      expect(retired.status).toBe(200);
      const rows = await occurrences(item.id);
      expect(rows.filter((r) => r.status === 'open')).toEqual([]);
      if (done.status === 200)
        // The completion came first: its next due day was called off.
        expect(rows.map((r) => r.status).sort()).toEqual(['cancelled', 'done']);
      else {
        expect(done.status).toBe(409);
        expect(done.body).toMatchObject({ code: 'COMPLIANCE_ITEM_RETIRED' });
        expect(rows.map((r) => r.status)).toEqual(['cancelled']);
      }
    }
  });
});
