import { CONTEST_OPEN_SWEEP } from '../../src/governance/contests/contest-sweeps';
import { eraseNow } from '../setup/erasure';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import {
  governanceHelpers,
  shiftElection,
  type Who,
} from '../setup/governance';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0051: what governance keeps of an account that goes — a seat ends,
 * a candidacy not yet voted on is withdrawn, an erasure clears the
 * statements and keeps the votes — and what an export of it holds.
 */
describe('Governance — privacy', () => {
  let h: HttpHarness;
  let g: ReturnType<typeof governanceHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof governanceHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    g = governanceHelpers(h);
    s = await g.setUp(4);
  }, 180_000);

  afterAll(() => h.close());

  const o = (i: number) => s.owners[i];
  /** A second owner living in `of`'s unit: not its primary, so they can go. */
  async function coOwner(of: Who & { unitId: string }) {
    const p = await g.x.resident(s.c, [of.unitId]);
    return { ...p, ...(await g.who(s.c, p.id, 'resident')), unitId: of.unitId };
  }
  const seatOf = async (accountId: string) =>
    (await g.staffBoard(s.manager))!.members.find(
      (m) => m.accountId === accountId,
    );
  const candidacies = (accountId: string) =>
    g.inTx(s.c, (tx) =>
      tx.governanceCandidate.findMany({
        where: { accountId },
        orderBy: { nominatedAt: 'asc' },
      }),
    );

  it('an erasure ends the seat, withdraws the candidacy, clears the statement and keeps the vote', async () => {
    const leaver = await coOwner(o(0));
    await g.appoint(s.manager, [o(1), o(2), leaver]);
    const e = await g.election(s.manager);
    await g.stand(leaver, e.id, 'PII-STATEMENT-leaver').expect(201);
    const p = await g.poll(s.manager, { secret: false, quorumPct: 10 });
    // o(0) is the unit's primary: the unit's voting owner, not the co-owner.
    await g.castVote(o(0), p.id, o(0).unitId, [g.option(p, 'yes')]).expect(201);

    await eraseNow(h, s.c, leaver.id);

    expect(await seatOf(leaver.id)).toMatchObject({
      endReason: 'account_closed',
    });
    const [c] = await candidacies(leaver.id);
    expect(c).toMatchObject({
      status: 'withdrawn',
      reasonCode: 'account_closed',
      statement: null,
    });
    expect(c.statementClearedAt).not.toBeNull();
    const staff = await g
      .http('get', `/staff/governance/elections/${e.id}`, s.manager.token)
      .expect(200);
    expect(JSON.stringify(staff.body)).not.toContain('PII-STATEMENT-leaver');
    expect(JSON.stringify(staff.body)).not.toContain(leaver.fullName);
    const contestId = await g.contestOf(s.c, p.id);
    expect(
      await g.inTx(s.c, (tx) =>
        tx.governanceParticipation.count({ where: { contestId } }),
      ),
    ).toBe(1);
  });

  it('deactivated: the seat ends; a candidacy on a list voting opened on stays', async () => {
    const e = await g.election(s.manager);
    await g.stand(o(2), e.id).expect(201);
    await shiftElection(e.id, -25);
    await g.sweep(CONTEST_OPEN_SWEEP);
    await g
      .http('patch', `/accounts/${o(2).id}/status`, s.manager.token, {
        status: 'inactive',
      })
      .expect(200);
    expect(await seatOf(o(2).id)).toMatchObject({
      endReason: 'account_closed',
    });
    expect(await candidacies(o(2).id)).toEqual([
      expect.objectContaining({ status: 'nominated', reasonCode: null }),
    ]);
    await g
      .http('patch', `/accounts/${o(2).id}/status`, s.manager.token, {
        status: 'active',
      })
      .expect(200);
  });

  it('no longer an owner: the seat ends; the vote of a contest already open stays theirs', async () => {
    const q = await g.poll(s.manager);
    await g.moveOut(s.c, o(1).unitId, o(1));
    expect(await seatOf(o(1).id)).toMatchObject({
      endReason: 'no_longer_owner',
    });
    expect(await g.permissionsOf(o(1))).not.toContain('governance.board');
    // The electorate is the snapshot taken when it opened.
    await g.castVote(o(1), q.id, o(1).unitId, [g.option(q, 'no')]).expect(201);
    await g.http('get', `/governance/polls/${q.id}`, o(1).token).expect(200);
    await g.http('get', '/governance/polls', o(1).token).expect(404);
  });

  it('an export holds the account’s seats, candidacies and its units’ votes; an open poll’s choice only', async () => {
    const who = o(3);
    const secret = await g.poll(s.manager);
    const open = await g.poll(s.manager, { secret: false });
    await g
      .castVote(who, secret.id, who.unitId, [g.option(secret, 'no')])
      .expect(201);
    await g
      .castVote(who, open.id, who.unitId, [g.option(open, 'abstain')])
      .expect(201);
    const e = await g.election(s.manager);
    await g.stand(who, e.id, 'My own words').expect(201);
    await g.stand(o(0), e.id, 'PII-STATEMENT-other').expect(201);
    const email = (
      await g.x.asManager(s.c, () =>
        g.x.prisma.tenant.account.findUniqueOrThrow({ where: { id: who.id } }),
      )
    ).email!;
    await stepUp(h, who.token, email);
    const asked = await g
      .http('post', '/me/data-exports', who.token, {})
      .expect(201);
    await buildExports(h);
    const dl = await g
      .http(
        'get',
        `/me/data-exports/${(asked.body as { id: string }).id}/download`,
        who.token,
      )
      .expect(200);
    const archive = await readArchive((dl.body as { url: string }).url);
    expect(archive.names).toEqual(
      expect.arrayContaining([
        'governance/board-seats.json',
        'governance/candidacies.json',
        'governance/votes.json',
      ]),
    );
    const votes = JSON.parse(archive.text('governance/votes.json')) as {
      contest: string;
      voted: boolean;
      votedByYou: boolean;
      choice: { key: string }[] | null;
    }[];
    const ref = (p: { reference: string }) =>
      votes.find((v) => v.contest === p.reference)!;
    expect(ref(secret)).toMatchObject({
      voted: true,
      votedByYou: true,
      choice: null,
    });
    expect(ref(open)).toMatchObject({
      voted: true,
      choice: [{ key: 'abstain' }],
    });
    const mine = JSON.parse(archive.text('governance/candidacies.json')) as {
      statement: string;
    }[];
    expect(mine).toEqual([
      expect.objectContaining({ statement: 'My own words' }),
    ]);
    expect(archive.all).not.toContain('PII-STATEMENT-other');
  });
});
