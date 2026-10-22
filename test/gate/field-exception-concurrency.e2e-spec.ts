import { dbClock } from '../setup/compound-clock';
import { gateCompletionHelpers } from '../setup/gate-completion';
import { superuserSql } from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { whileShiftEnds } from '../setup/shift-end';

const ROUNDS = 5;

/**
 * ADR 0056, the races of a field exception. Every answer, expiry,
 * withdrawal and entry takes the exception's row FOR UPDATE and reads the
 * database's clock after it, so:
 * - two deciders at once: one answer wins, the other is refused with it;
 * - an answer while the sweep expires it: one of the two, never both;
 * - an answer while the guard withdraws it: one of the two;
 * - two entries on one approval (two guards at its gate): one comes in,
 *   the other is refused as used.
 * - an entry while the guard's shift ends: the entry takes the account,
 *   then the shift, FOR SHARE (ADR 0056's lock order), so an end holding
 *   the shift makes it wait, and once committed it is refused.
 * Each outcome is checked against the row and the guard's notices.
 */
describe('Gate — a field exception, concurrently (ADR 0056)', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof gateCompletionHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof gateCompletionHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = gateCompletionHelpers(h);
    s = await g.setUp('Field Exception Race Court');
  }, 180_000);

  afterAll(() => h.close());

  const code = (res: { body: unknown }) => (res.body as { code?: string }).code;
  const notices = async (id: string, kind: string) =>
    (await g.told(s.c, s.guard.id, id)).filter((n) => n.kind === kind).length;

  it('two deciders at once: one answer wins, once', async () => {
    const second = await g.manager(s.c);
    for (let round = 0; round < ROUNDS; round++) {
      const x = await g.visitor(s.guard, s.unitCode);
      const [one, two] = await Promise.all([
        g.decideRaw(s.manager, x.id, { decision: 'approve' }),
        g.decideRaw(second, x.id, { decision: 'reject', reasonCode: 'other' }),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 409]);
      const winner = one.status === 200 ? 'approved' : 'rejected';
      const loser = one.status === 200 ? two : one;
      expect(loser.body).toMatchObject({
        code: 'GATE_EXCEPTION_DECIDED',
        params: { status: winner },
      });
      expect((await g.row(s.c, x.id)).status).toBe(winner);
      expect(await notices(x.id, 'gate_exception.decided')).toBe(1);
    }
  });

  it('an answer while the sweep expires it: one of the two', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const x = await g.visitor(s.guard, s.unitCode);
      // Due a few milliseconds from now: either may come first.
      await superuserSql(
        `UPDATE gate_field_exceptions
            SET raised_at = $2::timestamptz - interval '10 minutes', answer_by = $2
          WHERE id = $1`,
        [x.id, new Date(dbClock().getTime() + 30)],
      );
      const [answered] = await Promise.all([
        g.decideRaw(s.manager, x.id, { decision: 'approve' }),
        g.sweepExceptions(new Date(dbClock().getTime() + 60_000)),
      ]);
      const row = await g.row(s.c, x.id);
      if (answered.status === 200) {
        expect(row.status).toBe('approved');
        expect(await notices(x.id, 'gate_exception.expired')).toBe(0);
      } else {
        expect(answered.body).toMatchObject({
          code: 'GATE_EXCEPTION_DECIDED',
          params: { status: 'expired' },
        });
        expect(row.status).toBe('expired');
        expect(await notices(x.id, 'gate_exception.expired')).toBe(1);
      }
      // Whatever came first, a later sweep changes nothing.
      await g.sweepExceptions(new Date(dbClock().getTime() + 60_000));
      expect((await g.row(s.c, x.id)).status).toBe(row.status);
    }
    // Ten sweeps, each a transaction per compound in the shared test
    // database (160 and more late in a long run): longer than the default.
  }, 120_000);

  it('an answer while the guard withdraws it: one of the two', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const x = await g.visitor(s.guard, s.unitCode);
      const [answered, withdrawn] = await Promise.all([
        g.decideRaw(s.manager, x.id, { decision: 'approve' }),
        g.http(
          'post',
          `/gate/field-exceptions/${x.id}/withdraw`,
          s.guard.token,
        ),
      ]);
      expect([answered.status, withdrawn.status].sort()).toEqual([200, 409]);
      const row = await g.row(s.c, x.id);
      if (answered.status === 200) {
        expect(row.status).toBe('approved');
        expect(code(withdrawn)).toBe('GATE_EXCEPTION_DECIDED');
      } else {
        expect(row.status).toBe('withdrawn');
        expect(answered.body).toMatchObject({
          params: { status: 'withdrawn' },
        });
      }
    }
  });

  it('two entries on one approval, by two guards at its gate: one comes in', async () => {
    const other = await g.guardAt(s.c, s.guard.gateId);
    for (let round = 0; round < ROUNDS; round++) {
      const x = await g.visitor(s.guard, s.unitCode);
      await g.approve(s.manager, x.id);
      const [one, two] = await Promise.all([
        g.entryRaw(s.guard, 'field_exception', x.id),
        g.entryRaw(other, 'field_exception', x.id),
      ]);
      expect([one.status, two.status].sort()).toEqual([201, 409]);
      const refused = one.status === 409 ? one : two;
      expect(refused.body).toMatchObject({
        code: 'GATE_ENTRY_REFUSED',
        params: { reason: 'used' },
      });
      const row = await g.row(s.c, x.id);
      const recorded = one.status === 201 ? one : two;
      expect(row.usedEntryId).toBe((recorded.body as { id: string }).id);
      expect(
        await g.inTx(s.c, (tx) =>
          tx.gateEntry.count({
            where: { subjectId: x.id, direction: 'in' },
          }),
        ),
      ).toBe(1);
      // Out again, for the next round's guard at the gate.
      await g
        .entryRaw(s.guard, 'field_exception', x.id, { direction: 'out' })
        .expect(201);
    }
  });

  it('an entry while the guard’s shift ends: it waits for the end, then is refused', async () => {
    const leaving = await g.guardAt(s.c, s.guard.gateId);
    const x = await g.visitor(s.guard, s.unitCode);
    await g.approve(s.manager, x.id);
    const res = await whileShiftEnds(leaving.shiftId, () =>
      g.entryRaw(leaving, 'field_exception', x.id),
    );
    expect(res.status).toBe(403);
    expect(code(res)).toBe('NO_OPEN_SHIFT');
    expect(
      await g.inTx(s.c, (tx) =>
        tx.gateEntry.count({ where: { subjectId: x.id } }),
      ),
    ).toBe(0);
    expect((await g.row(s.c, x.id)).usedEntryId).toBeNull();
  });
});
