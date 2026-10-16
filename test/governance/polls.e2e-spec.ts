import {
  CONTEST_CLOSE_SWEEP,
  CONTEST_OPEN_SWEEP,
} from '../../src/governance/contests/contest-sweeps';
import {
  governanceHelpers,
  shiftContest,
  type PollBody,
  type Who,
} from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

const HOUR = 3_600_000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();

/**
 * ADR 0051: the owners' polls — who puts one, what it may be, the
 * electorate taken when it opens (one voting owner per unit), one vote per
 * unit that never changes, nothing counted in view while open, and the
 * result at the close.
 */
describe('Governance — polls', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof governanceHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof governanceHelpers>['setUp']>>;
  /** Sits on the board. */
  let chair: Who & { unitId: string };
  let owner: Who & { unitId: string };
  /** A unit rented out: its landlord votes, never its tenant. */
  let rented: { unitId: string; landlord: Who; tenant: Who };
  /** A unit with two owners: its primary votes. */
  let shared: { unitId: string; primary: Who; second: Who };

  beforeAll(async () => {
    h = await createHttpHarness();
    g = governanceHelpers(h);
    s = await g.setUp(4);
    [chair, owner] = s.owners;
    await g.appoint(s.manager, s.owners.slice(0, 3));
    const r = await g.unit(s.c, 'B');
    const landlord = await g.landlord(s.c, r.id);
    rented = { unitId: r.id, landlord, tenant: await g.tenant(s.c, r.id) };
    const sh = await g.unit(s.c, 'B');
    const primary = await g.owner(s.c, sh.id);
    const second = await g.who(
      s.c,
      (
        await g.x.asManager(s.c, () =>
          g.x.residents.createResident({
            ...g.x.person('co-owner'),
            units: [{ unitId: sh.id, occupancyType: 'owner', resides: true }],
          }),
        )
      ).id,
      'resident',
    );
    shared = { unitId: sh.id, primary, second };
  }, 180_000);

  afterAll(() => h.close());

  const code = (res: { body: unknown }) => (res.body as { code: string }).code;
  const fields = (res: { body: unknown }) =>
    (res.body as { fields: { field: string; code: string }[] }).fields.map(
      (f) => [f.field, f.code],
    );
  const closeAt = async (p: PollBody) => {
    await shiftContest(await g.contestOf(s.c, p.id), -80);
    await g.sweep(CONTEST_CLOSE_SWEEP);
  };

  describe('putting a poll', () => {
    it('a board member or the manager puts one; any other owner may not', async () => {
      const byChair = await g.poll(chair);
      expect(byChair).toMatchObject({ kind: 'yes_no', status: 'open' });
      expect(byChair.reference).toMatch(/^GP-\d{4}$/);
      expect(byChair.options.map((o) => o.key)).toEqual([
        'yes',
        'no',
        'abstain',
      ]);
      await g.poll(s.manager, { secret: false });
      const res = await g
        .http('post', '/governance/polls', s.owners[3].token, {
          kind: 'yes_no',
          titleEn: 'x',
          bodyEn: 'y',
          secret: true,
          quorumPct: 50,
          thresholdPct: 50,
          closesAt: inHours(48),
        })
        .expect(403);
      expect(code(res)).toBe('FORBIDDEN');
    });

    it('a yes/no poll takes no options; one of several takes 2 to 10 in its languages', async () => {
      const post = (body: object) =>
        g.http('post', '/governance/polls', chair.token, {
          titleEn: 'Which colour?',
          bodyEn: 'Pick one.',
          secret: true,
          quorumPct: 50,
          thresholdPct: 50,
          closesAt: inHours(48),
          ...body,
        });
      expect(
        fields(
          await post({
            kind: 'yes_no',
            options: [{ labelEn: 'A' }, { labelEn: 'B' }],
          }).expect(400),
        ),
      ).toEqual([['options', 'FIELD_NOT_ALLOWED']]);
      expect(
        fields(
          await post({ kind: 'choice', options: [{ labelEn: 'A' }] }).expect(
            400,
          ),
        ),
      ).toEqual([['options', 'INVALID_LENGTH']]);
      expect(
        fields(
          await post({
            kind: 'choice',
            options: [{ labelEn: 'Green' }, { labelAr: 'أزرق' }],
          }).expect(400),
        ),
      ).toEqual([
        ['options.1.labelEn', 'FIELD_REQUIRED'],
        ['options.1.labelAr', 'FIELD_NOT_ALLOWED'],
      ]);
      expect(
        fields(await post({ kind: 'yes_no', thresholdPct: 40 }).expect(400)),
      ).toEqual([['thresholdPct', 'INVALID_NUMBER']]);
      expect(
        fields(
          await post({ kind: 'yes_no', closesAt: inHours(0.5) }).expect(400),
        ),
      ).toEqual([['closesAt', 'INVALID_VALUE']]);
    });
  });

  describe('a scheduled poll', () => {
    let p: PollBody;

    it('is shown, takes no vote, and changes until it opens', async () => {
      p = await g.poll(chair, { opensAt: inHours(2), closesAt: inHours(30) });
      expect(p).toMatchObject({
        status: 'scheduled',
        electorate: null,
        turnout: null,
      });
      const seen = await g.pollAs(owner, p.id);
      expect(seen.myUnits).toEqual([]);
      const vote = await g.castVote(owner, p.id, owner.unitId, [
        g.option(p, 'yes'),
      ]);
      expect(vote.status).toBe(409);
      expect(code(vote)).toBe('GOVERNANCE_CONTEST_NOT_OPEN');
      const changed = await g
        .http('patch', `/governance/polls/${p.id}`, chair.token, {
          kind: 'choice',
          options: [{ labelEn: 'Green' }, { labelEn: 'Blue' }],
          quorumPct: 30,
        })
        .expect(200);
      expect((changed.body as PollBody).options.map((o) => o.key)).toEqual([
        null,
        null,
      ]);
      // Its secrecy is fixed: the edit does not take it.
      await g
        .http('patch', `/governance/polls/${p.id}`, chair.token, {
          secret: false,
        })
        .expect(400);
    });

    it('opens on time with its electorate: one voting owner per unit; then only a cancel', async () => {
      await g.sweep(CONTEST_OPEN_SWEEP, new Date(Date.now() + 3 * HOUR));
      const opened = await g.pollAs(owner, p.id);
      expect(opened.status).toBe('open');
      // Six units have owners: four homes, the rented unit, the shared one.
      expect(opened.electorate).toBe(6);
      expect(opened.myUnits).toEqual([
        expect.objectContaining({
          unitId: owner.unitId,
          voted: false,
          mayVote: true,
        }),
      ]);
      const edit = await g
        .http('patch', `/governance/polls/${p.id}`, chair.token, {
          quorumPct: 60,
        })
        .expect(409);
      expect(code(edit)).toBe('GOVERNANCE_CONTEST_STARTED');
      expect(
        (await g.pollAs(rented.landlord, p.id)).myUnits.map((u) => u.unitId),
      ).toEqual([rented.unitId]);
      expect(
        (await g.pollAs(shared.primary, p.id)).myUnits.map((u) => u.unitId),
      ).toEqual([shared.unitId]);
      expect((await g.pollAs(shared.second, p.id)).myUnits).toEqual([]);
    });
  });

  describe('voting', () => {
    let p: PollBody;

    beforeAll(async () => {
      p = await g.poll(chair);
    });

    it('a unit votes once, by its voting owner; the answer never says what', async () => {
      const res = await g
        .castVote(owner, p.id, owner.unitId, [g.option(p, 'yes')])
        .expect(201);
      expect(Object.keys(res.body as object).sort()).toEqual([
        'pollId',
        'unitId',
        'votedAt',
      ]);
      const again = await g
        .castVote(owner, p.id, owner.unitId, [g.option(p, 'no')])
        .expect(409);
      expect(code(again)).toBe('GOVERNANCE_ALREADY_VOTED');
      const notMine = await g
        .castVote(owner, p.id, chair.unitId, [g.option(p, 'no')])
        .expect(403);
      expect(code(notMine)).toBe('GOVERNANCE_NOT_ELECTOR');
      for (const who of [rented.tenant, shared.second]) {
        const r = await g
          .castVote(
            who,
            p.id,
            who === rented.tenant ? rented.unitId : shared.unitId,
            [g.option(p, 'no')],
          )
          .expect(403);
        expect(code(r)).toBe('GOVERNANCE_NOT_ELECTOR');
      }
      const view = await g.pollAs(owner, p.id);
      expect(view.myUnits).toEqual([
        expect.objectContaining({ voted: true, mayVote: false }),
      ]);
    });

    it('one option of the poll: anything else is refused without naming it', async () => {
      const two = await g
        .castVote(chair, p.id, chair.unitId, [
          g.option(p, 'yes'),
          g.option(p, 'no'),
        ])
        .expect(400);
      expect(fields(two)).toEqual([['optionIds', 'INVALID_LENGTH']]);
      const stranger = '0192f1c2-7a4b-4c3d-8e9f-0a1b2c3d4e5f';
      const wrong = await g
        .castVote(chair, p.id, chair.unitId, [stranger])
        .expect(400);
      expect(fields(wrong)).toEqual([['optionIds', 'INVALID_VALUE']]);
      expect(JSON.stringify(wrong.body)).not.toContain(stranger);
    });

    it('while open nobody sees a count, the staff included; the turnout shows', async () => {
      const mine = await g.pollAs(owner, p.id);
      expect(mine.turnout).toBe(1);
      expect(mine.options.map((o) => o.votes)).toEqual([null, null, null]);
      const staff = await g
        .http('get', `/staff/governance/polls/${p.id}`, s.manager.token)
        .expect(200);
      expect((staff.body as PollBody).options.map((o) => o.votes)).toEqual([
        null,
        null,
        null,
      ]);
      expect((staff.body as PollBody).rollCall).toBeNull();
    });

    it('a tenant finds no poll; the clock refuses a vote after the close, before any count', async () => {
      const t = await g
        .http('get', `/governance/polls/${p.id}`, rented.tenant.token)
        .expect(404);
      expect(code(t)).toBe('GOVERNANCE_NOT_AVAILABLE');
      await shiftContest(await g.contestOf(s.c, p.id), -80);
      const late = await g
        .castVote(chair, p.id, chair.unitId, [g.option(p, 'yes')])
        .expect(409);
      expect(code(late)).toBe('GOVERNANCE_CONTEST_NOT_OPEN');
      expect((await g.pollAs(owner, p.id)).status).toBe('closed');
    });
  });

  describe('the close', () => {
    it('a secret poll: counts and result, no roll call', async () => {
      const p = await g.poll(chair, { quorumPct: 50, thresholdPct: 50 });
      for (const who of [chair, owner, s.owners[2]])
        await g
          .castVote(who, p.id, who.unitId, [g.option(p, 'yes')])
          .expect(201);
      await g
        .castVote(rented.landlord, p.id, rented.unitId, [g.option(p, 'no')])
        .expect(201);
      await closeAt(p);
      const closed = await g.pollAs(s.owners[3], p.id);
      expect(closed).toMatchObject({
        status: 'closed',
        electorate: 6,
        turnout: 4,
        result: 'passed',
        rollCall: null,
        rollCallPublic: false,
      });
      expect(closed.options.map((o) => [o.key, o.votes])).toEqual([
        ['yes', 3],
        ['no', 1],
        ['abstain', 0],
      ]);
    });

    it('below the quorum nothing passes', async () => {
      const p = await g.poll(chair, { quorumPct: 80 });
      await g
        .castVote(chair, p.id, chair.unitId, [g.option(p, 'yes')])
        .expect(201);
      await closeAt(p);
      expect((await g.pollAs(owner, p.id)).result).toBe('no_quorum');
    });

    it('an open vote shows each unit’s choice to the owners once closed, by unit code', async () => {
      const p = await g.poll(s.manager, {
        kind: 'choice',
        secret: false,
        quorumPct: 10,
        options: [{ labelEn: 'Green' }, { labelEn: 'Blue' }],
      });
      expect(p.rollCallPublic).toBe(true);
      const [green, blue] = p.options.map((o) => o.id);
      await g.castVote(chair, p.id, chair.unitId, [green]).expect(201);
      await g.castVote(owner, p.id, owner.unitId, [blue]).expect(201);
      await g
        .castVote(s.owners[2], p.id, s.owners[2].unitId, [green])
        .expect(201);
      expect((await g.pollAs(owner, p.id)).rollCall).toBeNull();
      await closeAt(p);
      const closed = await g.pollAs(s.owners[3], p.id);
      expect(closed).toMatchObject({
        result: 'passed',
        winningOptionId: green,
      });
      expect(closed.rollCall).toHaveLength(3);
      expect(closed.rollCall!.map((e) => e.choice)).toEqual(
        expect.arrayContaining([[green], [blue], [green]]),
      );
      expect(JSON.stringify(closed.rollCall)).not.toContain(chair.id);
    });
  });

  describe('a cancel', () => {
    it('needs a reason; it ends the poll with nothing counted, and a closed poll stays closed', async () => {
      const p = await g.poll(chair);
      await g
        .castVote(owner, p.id, owner.unitId, [g.option(p, 'yes')])
        .expect(201);
      const cancel = (id: string, reasonCode?: string) =>
        g.http('post', `/governance/polls/${id}/cancel`, chair.token, {
          ...(reasonCode ? { reasonCode } : {}),
        });
      expect(code(await cancel(p.id).expect(400))).toBe('VALIDATION_FAILED');
      const done = await cancel(p.id, 'superseded').expect(200);
      expect(done.body).toMatchObject({
        status: 'cancelled',
        cancelReasonCode: 'superseded',
        result: null,
      });
      const contestId = await g.contestOf(s.c, p.id);
      expect(
        await g.inTx(s.c, (tx) =>
          tx.governanceBallotBox.count({ where: { contestId } }),
        ),
      ).toBe(0);
      const vote = await g
        .castVote(chair, p.id, chair.unitId, [g.option(p, 'yes')])
        .expect(409);
      expect(code(vote)).toBe('GOVERNANCE_CONTEST_NOT_OPEN');
      expect(code(await cancel(p.id, 'other').expect(409))).toBe(
        'GOVERNANCE_CONTEST_ENDED',
      );
    });
  });
});
