import { ACCESS_REVIEW_SWEEP } from '../../src/core/account-checks/access-reviews.service';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { auditReaders } from '../setup/audit';
import { dispatchHelpers } from '../setup/dispatch';
import { engagementHelpers } from '../setup/engagement';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

// eslint-disable-next-line no-restricted-syntax -- a real duration in ms: the sweep's own now and the rules it checks count 24-hour days
const DAY = 86_400_000;

interface Line {
  id: string;
  account: { id: string };
  accountType: string;
  role: { key: string | null };
  permissions: string[];
  protected: boolean;
  decision: string | null;
}
interface Review {
  id: string;
  number: string;
  status: string;
  openedBy: { id: string } | null;
  lines: number;
  kept: number;
  revoked: number;
  left: number;
  undecided: number;
  reviewLines: Line[];
}

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
});

/**
 * ADR 0090: an access review is a frozen snapshot of who has access on the
 * compound's side, every line kept or revoked once by `accounts.manage`
 * (revoked deactivates in the same transaction), never one's own, the
 * system manager kept only; it closes with its last line.
 */
describe('Access reviews', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let audit: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(3);
    audit = auditReaders(h);
  }, 120_000);

  afterAll(() => h.close());

  const decide = (r: Review, line: Line, decision: string) =>
    d.http(
      'post',
      `/staff/access/reviews/${r.id}/lines/${line.id}/decide`,
      s.manager.token,
      { decision },
    );
  const lineOf = (r: Review, accountId: string) =>
    r.reviewLines.find((l) => l.account.id === accountId)!;

  it('the sweep opens one when the cadence passed since the compound began; never two', async () => {
    const sweep = (at: Date) =>
      h.moduleRef.get(SweepRunner).run(ACCESS_REVIEW_SWEEP, at);
    // Other suites' compounds share the database: this compound's own count.
    const mine = () => d.inTenant(s.c, (tx) => tx.accessReview.count());
    await sweep(new Date());
    expect(await mine()).toBe(0);

    // eslint-disable-next-line test-clock/day-multiple -- a real duration in ms: the sweep's own now and the rules it checks count 24-hour days
    const later = new Date(Date.now() + 91 * DAY);
    expect(await sweep(later)).toBeGreaterThanOrEqual(1);
    await sweep(later);
    expect(await mine()).toBe(1);
    const list = (
      await d.http('get', '/staff/access/reviews', s.manager.token).expect(200)
    ).body as { data: Review[] };
    expect(list.data).toEqual([
      expect.objectContaining({ status: 'open', openedBy: null }),
    ]);
    expect(
      code(await d.http('post', '/staff/access/reviews', s.manager.token)),
    ).toEqual({ status: 409, code: 'ACCESS_REVIEW_OPEN' });
    expect(
      (
        await engagementHelpers(h).notifications(
          s.c,
          s.c.managerId,
          'access_review.opened',
        )
      ).map((n) => n.targetId),
    ).toEqual([list.data[0].id]);
  });

  it('each line decided once, never one’s own, the manager kept only; revoke deactivates; a leaver is `left`; closed with the last line', async () => {
    const r = (
      await d.http('get', '/staff/access/reviews', s.manager.token).expect(200)
    ).body as { data: Review[] };
    const review = (
      await d
        .http('get', `/staff/access/reviews/${r.data[0].id}`, s.manager.token)
        .expect(200)
    ).body as Review;
    expect(review.number).toMatch(/^AR-\d{6}$/);
    const types = new Set(review.reviewLines.map((l) => l.accountType));
    expect(
      [...types].every((t) => ['staff', 'manager', 'contractor'].includes(t)),
    ).toBe(true);
    const manager = lineOf(review, s.c.managerId);
    expect(manager).toMatchObject({ protected: true, accountType: 'manager' });
    expect(lineOf(review, s.techs[0].id).permissions).toContain('tickets.work');
    expect(review.reviewLines.map((l) => l.account.id)).not.toContain(
      s.owner.id,
    );
    // The manager's own line, and the protected line, by someone else.
    expect(code(await decide(review, manager, 'keep'))).toEqual({
      status: 403,
      code: 'ACCESS_REVIEW_OWN_LINE',
    });
    const supervisorLine = lineOf(review, s.supervisor.id);
    await decide(review, supervisorLine, 'keep').expect(200);
    expect(code(await decide(review, supervisorLine, 'revoke'))).toEqual({
      status: 409,
      code: 'ACCESS_REVIEW_LINE_DECIDED',
    });
    // Revoked: the technician is deactivated in the same transaction.
    await decide(review, lineOf(review, s.techs[0].id), 'revoke').expect(200);
    expect(
      (
        await d.inTenant(s.c, (tx) =>
          tx.account.findUniqueOrThrow({ where: { id: s.techs[0].id } }),
        )
      ).status,
    ).toBe('inactive');
    // Deactivated by another path: its line is left by the system.
    await d.x.asManager(s.c, () =>
      h.moduleRef
        .get(AccountsService)
        .updateStatus(s.techs[1].id, { status: 'inactive' }),
    );
    let now = (
      await d
        .http('get', `/staff/access/reviews/${review.id}`, s.manager.token)
        .expect(200)
    ).body as Review;
    expect(lineOf(now, s.techs[1].id).decision).toBe('left');
    // The rest kept, but the manager's own: the supervisor keeps it.
    for (const l of now.reviewLines)
      if (!l.decision && l.account.id !== s.c.managerId)
        await decide(now, l, 'keep').expect(200);
    const asSupervisor = await d.http(
      'post',
      `/staff/access/reviews/${review.id}/lines/${manager.id}/decide`,
      s.supervisor.token,
      { decision: 'revoke' },
    );
    // The supervisor holds no accounts.manage.
    expect(asSupervisor.status).toBe(403);
    // Another holder of it: a second manager-kind account would be needed;
    // the manager's line is kept by the system only when it leaves. Here
    // the review stays open with that one line.
    now = (
      await d
        .http('get', `/staff/access/reviews/${review.id}`, s.manager.token)
        .expect(200)
    ).body as Review;
    expect(now).toMatchObject({
      status: 'open',
      undecided: 1,
      revoked: 1,
      left: 1,
    });
    expect(
      (
        await audit.tenant(s.c.tenantId, {
          action: 'access_review.line_decided',
          targetId: review.id,
        })
      ).map((a) => (a.metadata as { decision: string }).decision),
    ).toEqual(expect.arrayContaining(['keep', 'revoke', 'left']));
  });

  it('a review opened by hand, its lines all decided by someone else, closes', async () => {
    const other = await d.x.compound();
    const manager = await d.who(other, other.managerId, 'manager');
    // A second holder of accounts.manage: another account on the manager role.
    const deputy = await h.createAccount(other.tenantId, {
      type: 'manager',
      email: uniqueEmail('reviewer'),
      phone: uniquePhone(),
    });
    const second = await d.who(other, deputy.id, 'manager');
    const opened = (
      await d.http('post', '/staff/access/reviews', manager.token).expect(201)
    ).body as Review;
    expect(opened.openedBy).toEqual(
      expect.objectContaining({ id: other.managerId }),
    );
    for (const l of opened.reviewLines) {
      const by = l.account.id === other.managerId ? second : manager;
      await d
        .http(
          'post',
          `/staff/access/reviews/${opened.id}/lines/${l.id}/decide`,
          by.token,
          { decision: 'keep' },
        )
        .expect(200);
    }
    const closed = (
      await d
        .http('get', `/staff/access/reviews/${opened.id}`, manager.token)
        .expect(200)
    ).body as Review;
    expect(closed).toMatchObject({
      status: 'closed',
      kept: opened.lines,
      undecided: 0,
    });
    expect(
      (
        await audit.tenant(other.tenantId, {
          action: 'access_review.closed',
          targetId: opened.id,
        })
      )[0],
    ).toMatchObject({ metadata: { kept: opened.lines, revoked: 0, left: 0 } });
  });
});
