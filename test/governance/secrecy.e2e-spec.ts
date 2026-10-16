import { Client } from 'pg';
import { CONTEST_CLOSE_SWEEP } from '../../src/governance/contests/contest-sweeps';
import {
  governanceHelpers,
  shiftContest,
  shiftElection,
  type PollBody,
  type Who,
} from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { required } from '../setup/test-env';
import { CONTEST_OPEN_SWEEP } from '../../src/governance/contests/contest-sweeps';

const V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * ADR 0051: a secret ballot cannot be tied back to its unit — not through a
 * column, a key, a system column (`xmin`, `ctid`), the order rows were
 * written in, an idempotency record, the audit trail, a notification or an
 * outbox row, and not through any answer of the API while voting is open.
 * Eight units vote, in a known order, known choices.
 */
describe('Governance — the secret ballot', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof governanceHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof governanceHelpers>['setUp']>>;
  let db: Client;
  let p: PollBody;
  let contestId: string;
  let optionIds: string[];
  /** What each voter chose, in the order they voted. */
  const chose: { who: Who & { unitId: string }; option: string }[] = [];

  beforeAll(async () => {
    h = await createHttpHarness();
    g = governanceHelpers(h);
    s = await g.setUp(8);
    db = new Client({
      connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
    });
    await db.connect();
    p = await g.poll(s.manager, {
      kind: 'choice',
      quorumPct: 10,
      options: [{ labelEn: 'Red' }, { labelEn: 'Green' }, { labelEn: 'Blue' }],
    });
    contestId = await g.contestOf(s.c, p.id);
    optionIds = p.options.map((o) => o.id);
    for (const [i, who] of s.owners.entries()) {
      const option = optionIds[i % 3];
      chose.push({ who, option });
      await g
        .castVote(who, p.id, who.unitId, [option], {
          'Idempotency-Key': `secret-${i}-${p.id}`,
        })
        .expect(201);
    }
  }, 240_000);

  afterAll(async () => {
    await db.end();
    await h.close();
  });

  const q = async <T>(sql: string, params: unknown[] = []) =>
    (await db.query(sql, params)).rows as T[];
  const ids = () => [
    ...s.owners.map((o) => o.id),
    ...s.owners.map((o) => o.unitId),
  ];

  describe('while voting is open', () => {
    it('S1: the box holds random v4 keys and choices, and no unit or account', async () => {
      const [box] = await q<{ ballots: Record<string, string[]> }>(
        `SELECT ballots FROM governance_ballot_boxes WHERE contest_id = $1`,
        [contestId],
      );
      const keys = Object.keys(box.ballots);
      expect(keys).toHaveLength(8);
      for (const k of keys) expect(k).toMatch(V4);
      const text = JSON.stringify(box);
      for (const id of ids()) expect(text).not.toContain(id);
    });

    it('S3: the box’s keys come out sorted, never in the order they went in', async () => {
      const rows = await q<{ key: string }>(
        `SELECT k AS key FROM governance_ballot_boxes b, jsonb_object_keys(b.ballots) k WHERE b.contest_id = $1`,
        [contestId],
      );
      const keys = rows.map((r) => r.key);
      expect(keys).toEqual(
        [...keys].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)),
      );
    });

    it('S2: the box’s xmin is the last vote’s alone; no other participation shares it', async () => {
      const [box] = await q<{ x: string }>(
        `SELECT xmin::text AS x FROM governance_ballot_boxes WHERE contest_id = $1`,
        [contestId],
      );
      const parts = await q<{ unit_id: string; x: string }>(
        `SELECT unit_id, xmin::text AS x FROM governance_participations WHERE contest_id = $1`,
        [contestId],
      );
      const sharing = parts.filter((r) => r.x === box.x).map((r) => r.unit_id);
      expect(sharing).toEqual([chose[chose.length - 1].who.unitId]);
    });

    it('S4: the idempotency records hold no choice: one request hash whatever was chosen', async () => {
      const rows = await q<{ request_hash: string; response_body: unknown }>(
        `SELECT request_hash, response_body FROM idempotency_keys WHERE key LIKE $1`,
        [`secret-%-${p.id}`],
      );
      expect(rows).toHaveLength(8);
      const text = JSON.stringify(rows.map((r) => r.response_body));
      for (const id of optionIds) expect(text).not.toContain(id);
      // Every account's hash is the same request's: the body is left out.
      expect(new Set(rows.map((r) => r.request_hash)).size).toBe(1);
    });

    it('S5: the audit, the notifications and the outbox hold no choice', async () => {
      const audit = await q<{ row: unknown }>(
        `SELECT to_jsonb(a) AS row FROM audit_log a WHERE tenant_id = $1`,
        [s.c.tenantId],
      );
      const notes = await q<{ row: unknown }>(
        `SELECT to_jsonb(n) AS row FROM notifications n WHERE tenant_id = $1`,
        [s.c.tenantId],
      );
      const outbox = await q<{ row: unknown }>(
        `SELECT to_jsonb(o) AS row FROM outbox_messages o WHERE tenant_id = $1`,
        [s.c.tenantId],
      );
      const text = JSON.stringify([audit, notes, outbox]);
      // An option's id appears where the poll was put and counted, never
      // next to a vote: the vote's entries hold the unit alone.
      const votes = audit.filter(
        (r) => (r.row as { action: string }).action === 'governance.vote_cast',
      );
      expect(votes).toHaveLength(8);
      for (const id of optionIds)
        expect(JSON.stringify(votes)).not.toContain(id);
      for (const id of optionIds)
        expect(JSON.stringify([notes, outbox])).not.toContain(id);
      // No row has a field named after a choice (a poll's kind may be one).
      expect(text).not.toMatch(/"choice":/);
    });

    it('S6: no answer carries a count, and a voter’s view is the same whatever they chose', async () => {
      const [red, green] = [chose[0], chose[1]];
      const view = async (w: Who) => {
        const v = await g.pollAs(w, p.id);
        return JSON.stringify({
          ...v,
          myUnits: v.myUnits.map((u) => ({ ...u, unitId: '', unitCode: '' })),
        });
      };
      expect(await view(red.who)).toBe(await view(green.who));
      const staff = await g
        .http('get', `/staff/governance/polls/${p.id}`, s.manager.token)
        .expect(200);
      expect((staff.body as PollBody).options.map((o) => o.votes)).toEqual([
        null,
        null,
        null,
      ]);
    });
  });

  describe('once closed', () => {
    beforeAll(async () => {
      await shiftContest(contestId, -80);
      await g.sweep(CONTEST_CLOSE_SWEEP);
    });

    it('the counts are right, and the box is gone', async () => {
      const closed = await g.pollAs(s.owners[0], p.id);
      expect(closed.options.map((o) => o.votes)).toEqual([3, 3, 2]);
      expect(
        await q(`SELECT 1 FROM governance_ballot_boxes WHERE contest_id = $1`, [
          contestId,
        ]),
      ).toEqual([]);
    });

    it('S1: a ballot row is an id, the contest and the choice', async () => {
      const rows = await q<Record<string, unknown>>(
        `SELECT * FROM governance_ballots WHERE contest_id = $1`,
        [contestId],
      );
      expect(rows).toHaveLength(8);
      for (const r of rows) {
        expect(Object.keys(r).sort()).toEqual([
          'choice',
          'contest_id',
          'id',
          'tenant_id',
        ]);
        expect(r.id).toMatch(V4);
      }
      for (const id of ids()) expect(JSON.stringify(rows)).not.toContain(id);
    });

    it('S2: every ballot has the close’s xmin; no participation or vote entry shares it', async () => {
      const ballots = await q<{ x: string }>(
        `SELECT DISTINCT xmin::text AS x FROM governance_ballots WHERE contest_id = $1`,
        [contestId],
      );
      expect(ballots).toHaveLength(1);
      const parts = await q<{ x: string }>(
        `SELECT xmin::text AS x FROM governance_participations WHERE contest_id = $1`,
        [contestId],
      );
      const votes = await q<{ x: string }>(
        `SELECT xmin::text AS x FROM audit_log WHERE action = 'governance.vote_cast' AND target_id = $1`,
        [contestId],
      );
      for (const r of [...parts, ...votes]) expect(r.x).not.toBe(ballots[0].x);
    });

    it('S3: the rows lie in the order of their random ids, not the order of voting', async () => {
      const rows = await q<{ id: string; choice: string[] }>(
        `SELECT id::text AS id, choice::text[] AS choice FROM governance_ballots
          WHERE contest_id = $1 ORDER BY ctid`,
        [contestId],
      );
      const order = rows.map((r) => r.id);
      expect(order).toEqual([...order].sort());
    });
  });

  it('an election’s ballots are kept the same way', async () => {
    const e = await g.election(s.manager);
    for (const who of s.owners.slice(0, 4))
      await g.stand(who, e.id).expect(201);
    await shiftElection(e.id, -25);
    await g.sweep(CONTEST_OPEN_SWEEP);
    const candidates = (await g.electionAs(s.owners[0], e.id)).candidates.map(
      (c) => c.id,
    );
    for (const [i, who] of s.owners.entries())
      await g
        .electionVote(who, e.id, who.unitId, [
          candidates[i % 4],
          candidates[(i + 1) % 4],
        ])
        .expect(201);
    const [{ contest_id }] = await q<{ contest_id: string }>(
      `SELECT contest_id FROM governance_elections WHERE id = $1`,
      [e.id],
    );
    const [box] = await q<{ ballots: Record<string, string[]> }>(
      `SELECT ballots FROM governance_ballot_boxes WHERE contest_id = $1`,
      [contest_id],
    );
    for (const k of Object.keys(box.ballots)) expect(k).toMatch(V4);
    await shiftElection(e.id, -25);
    await g.sweep(CONTEST_CLOSE_SWEEP);
    const rows = await q<{ id: string }>(
      `SELECT id::text AS id FROM governance_ballots WHERE contest_id = $1 ORDER BY ctid`,
      [contest_id],
    );
    expect(rows).toHaveLength(8);
    expect(rows.map((r) => r.id)).toEqual(rows.map((r) => r.id).sort());
    const closed = await g.electionAs(s.owners[5], e.id);
    expect(closed.candidates.map((c) => c.votes)).toEqual([4, 4, 4, 4]);
  });
});
