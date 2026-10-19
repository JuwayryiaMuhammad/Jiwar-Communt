import { boardAppealHelpers } from '../setup/board-appeals';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const ROUNDS = 5;

/**
 * ADR 0055, recusal under a race: a board member is made an owner of the
 * appeal's unit while a motion on the appeal opens, then votes. The
 * motion's recusals are the snapshot of its opening: the member is recused
 * exactly when the snapshot holds them, their vote is refused exactly
 * then, and a join after the opening never changes the motion's count.
 */
describe('Governance — recusal, concurrently (ADR 0055)', () => {
  let h: HttpHarness;
  let a: ReturnType<typeof boardAppealHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof boardAppealHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    a = boardAppealHelpers(h);
    s = await a.setUp(4, 3);
  }, 240_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];

  it('a member joins the unit while the motion opens, then votes: recused exactly by the snapshot', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const unit = await a.unit(s.c);
      const owner = await a.owner(s.c, unit.id);
      const d = await a.rejectedDispute(s.manager, owner, unit.id);
      const x = await a.appeal(owner, d);
      const [opened, joined] = await Promise.all([
        a.proposeOn(o(0), x.id),
        a.http('post', `/residents/${o(2).id}/occupancies`, s.manager.token, {
          unitId: unit.id,
          occupancyType: 'owner',
          resides: false,
        }),
      ]);
      expect(opened.status).toBe(201);
      expect(joined.status).toBe(201);
      const motionId = (opened.body as { id: string }).id;
      const recused = await a.inTx(s.c, (tx) =>
        tx.boardMotionRecusal.findMany({ where: { motionId } }),
      );
      const snapshot = recused.some((r) => r.accountId === o(2).id);
      const voted = await a.vote(o(2), motionId, 'for');
      if (snapshot) {
        expect(voted.status).toBe(403);
        expect((voted.body as { code: string }).code).toBe(
          'BOARD_MEMBER_RECUSED',
        );
      } else {
        expect(voted.status).toBe(201);
        expect((voted.body as { tally: { seats: number } }).tally.seats).toBe(
          3,
        );
      }
      // The snapshot never changes after the opening.
      expect(
        await a.inTx(s.c, (tx) =>
          tx.boardMotionRecusal.count({ where: { motionId } }),
        ),
      ).toBe(recused.length);
    }
  });
});
