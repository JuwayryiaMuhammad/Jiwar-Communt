import { DANGLING_SWEEP } from '../../src/core/account-checks/dangling-accounts.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { auditReaders } from '../setup/audit';
import { dispatchHelpers } from '../setup/dispatch';
import { engagementHelpers } from '../setup/engagement';
import { nationalIdFor, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

// eslint-disable-next-line no-restricted-syntax -- a real duration in ms: the sweep's own now and the rules it checks count 24-hour days
const DAY = 86_400_000;

interface Finding {
  id: string;
  account: { id: string };
  accountType: string;
  reason: string;
  status: string;
  reasonCode: string | null;
  mutedUntil: string | null;
}

/** An instant `days` from now: the sweep is run as of then. */

// eslint-disable-next-line test-clock/day-multiple -- a real duration in ms: the sweep's own now and the rules it checks count 24-hour days
const later = (days: number) => new Date(Date.now() + days * DAY);

/**
 * ADR 0090: an active account of the compound's side (staff, manager,
 * contractor) that looks dangling — idle for the compound's days, never
 * signed into within 14 days, or a contractor whose vendor is suspended —
 * is found by the sweep and told once to `accounts.manage`; kept with a
 * code (muted 90 days) or deactivated once, never one's own; cleared when
 * it no longer holds.
 */
describe('Dangling accounts', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let audit: ReturnType<typeof auditReaders>;
  const run = (now: Date) =>
    h.moduleRef.get(SweepRunner).run(DANGLING_SWEEP, now);
  const findings = async (status?: string) =>
    (
      (
        await d
          .http(
            'get',
            `/staff/access/dangling-accounts${status ? `?status=${status}` : ''}`,
            s.manager.token,
          )
          .expect(200)
      ).body as { data: Finding[] }
    ).data;
  const of = async (accountId: string, status = 'open') =>
    (await findings(status)).filter((f) => f.account.id === accountId);

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    audit = auditReaders(h);
  }, 120_000);

  afterAll(() => h.close());

  it('never signed into within 14 days, idle past the compound’s days: found once, told once, an inbox item', async () => {
    // Nobody ever signs in as this one: no token, no session.
    const silent = (await d.g.guard(s.c, 'technician')).id;
    await run(new Date());
    expect(await of(silent)).toEqual([]);
    await run(later(15));
    await run(later(15));
    expect(await of(silent)).toEqual([
      expect.objectContaining({
        reason: 'never_signed_in',
        accountType: 'staff',
        status: 'open',
      }),
    ]);
    // The technician signed in (their token is a session): idle only after
    // the 60 days.
    expect(await of(s.techs[0].id)).toEqual([]);
    await run(later(61));
    const idle = await of(s.techs[0].id);
    expect(idle).toEqual([expect.objectContaining({ reason: 'idle' })]);
    const notices = (
      await engagementHelpers(h).notifications(s.c, s.c.managerId)
    ).filter((n) => n.kind === 'dangling_account.found');
    expect(
      notices.filter((n) => n.targetId === idle[0].id).map((n) => n.params),
    ).toEqual([{ reason: 'idle' }]);
    const inbox = (
      await d
        .http('get', '/staff/inbox?type=dangling_account', s.manager.token)
        .expect(200)
    ).body as { data: { id: string; kind: string }[] };
    expect(inbox.data.map((r) => r.id)).toContain(idle[0].id);
    // A technician holds no accounts.manage.
    expect(
      (await d.http('get', '/staff/access/dangling-accounts', s.techs[0].token))
        .status,
    ).toBe(403);
  });

  it('kept with a code is muted 90 days; deactivated once; never one’s own; cleared once it no longer holds', async () => {
    const kept = (await d.g.guard(s.c, 'technician')).id;
    const gone = (await d.g.guard(s.c, 'technician')).id;
    const back = await d.who(
      s.c,
      (await d.g.guard(s.c, 'technician')).id,
      'staff',
    );
    await run(later(61));
    const [k] = await of(kept);
    const keep = (body: object) =>
      d.http(
        'post',
        `/staff/access/dangling-accounts/${k.id}/keep`,
        s.manager.token,
        body,
      );
    expect((await keep({})).status).toBe(400);
    expect(
      (await keep({ reasonCode: 'on_leave' }).expect(200)).body,
    ).toMatchObject({ status: 'kept', reasonCode: 'on_leave' });
    expect((await keep({ reasonCode: 'on_leave' })).body).toMatchObject({
      code: 'DANGLING_ACCOUNT_DECIDED',
      params: { status: 'kept' },
    });
    await run(later(62));
    expect(await of(kept)).toEqual([]);
    // Past the 90 days it is found again.
    await run(later(152));
    expect(await of(kept)).toHaveLength(1);

    const [g] = await of(gone);
    expect(
      (
        await d
          .http(
            'post',
            `/staff/access/dangling-accounts/${g.id}/deactivate`,
            s.manager.token,
          )
          .expect(200)
      ).body,
    ).toMatchObject({ status: 'deactivated' });
    const row = await d.inTenant(s.c, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: gone } }),
    );
    expect(row.status).toBe('inactive');
    expect(
      (
        await audit.tenant(s.c.tenantId, {
          action: 'dangling_account.deactivated',
          targetId: gone,
        })
      )[0],
    ).toMatchObject({ actorId: s.c.managerId, metadata: { findingId: g.id } });

    // The manager's own finding (never signed in through a session of its
    // own here) is someone else's to decide.
    const [own] = await of(s.c.managerId);
    if (own)
      expect(
        (
          await d.http(
            'post',
            `/staff/access/dangling-accounts/${own.id}/keep`,
            s.manager.token,
            { reasonCode: 'other' },
          )
        ).body,
      ).toMatchObject({ code: 'CANNOT_CHANGE_OWN_STATUS' });

    // Found idle, then signed in again: cleared by the sweep.
    const [b] = await of(back.id);
    expect(b).toBeDefined();
    await h.tokenFor({ sub: back.id, tid: s.c.tenantId, typ: 'staff' });
    // As of a day the new session is not idle yet.
    await run(new Date());
    expect(await of(back.id)).toEqual([]);
    expect(
      (
        await audit.tenant(s.c.tenantId, {
          action: 'dangling_account.cleared',
          targetId: back.id,
        })
      ).at(-1),
    ).toMatchObject({
      actorType: 'system',
      metadata: { findingId: b.id, why: 'active_again' },
    });
  });

  it('a contractor whose vendor is suspended is dangling at once', async () => {
    const vendor = (
      (
        await d
          .http('post', '/staff/vendors', s.manager.token, {
            name: `Dangling Works ${uniqueSuffix()}`,
            categories: ['maintenance'],
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    const made = await d
      .http('post', `/staff/vendors/${vendor}/contractors`, s.manager.token, {
        fullName: 'Contractor Person',
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(new Date('1990-05-05')),
        phone: uniquePhone(),
        email: uniqueEmail('dangling'),
      })
      .expect(201);
    const contractor: Who = {
      id: (made.body as { id: string }).id,
      token: '',
    };
    await run(new Date());
    expect(await of(contractor.id)).toEqual([]);
    await d
      .http('post', `/staff/vendors/${vendor}/suspend`, s.manager.token, {
        reasonCode: 'performance',
      })
      .expect(200);
    await run(new Date());
    expect(await of(contractor.id)).toEqual([
      expect.objectContaining({
        reason: 'vendor_suspended',
        accountType: 'contractor',
      }),
    ]);
  });
});
