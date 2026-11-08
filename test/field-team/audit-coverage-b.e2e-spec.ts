import { Client } from 'pg';
import { ACCESS_REVIEW_SWEEP } from '../../src/core/account-checks/access-reviews.service';
import { DANGLING_SWEEP } from '../../src/core/account-checks/dangling-accounts.service';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { SERVICE_PRESSURE_SWEEP } from '../../src/maintenance/dispatch/service-pressure';
import { REINFORCEMENT_SWEEP } from '../../src/maintenance/reinforcement/reinforcement.service';
import { auditReaders } from '../setup/audit';
import { FIELD_TEAM_B_COVERAGE } from '../setup/audit-coverage-split';
import { day } from '../setup/compound-clock';
import { dispatchHelpers } from '../setup/dispatch';
import { eraseNow } from '../setup/erasure';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { required } from '../setup/test-env';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

const HOUR = 3_600_000;
// eslint-disable-next-line no-restricted-syntax -- a real duration in ms: the sweep's own now and the rules it checks count 24-hour days
const DAY = 24 * HOUR;
const MARKER = 'AUDIT-m212b-secret';
/** An ISO instant `ms` from now. */

const ahead = (ms: number) => new Date(Date.now() + ms);

/**
 * One scenario per entry of the field team's part b (ADR 0014, 0090):
 * actor, target and metadata — ids, codes, days and counts; never a
 * coordinate, a certificate's number or anyone's words.
 */
const covered = new Set<string>();

describe('Audit coverage — the field team, part b', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let read: ReturnType<typeof auditReaders>;
  let s: SetUp;
  const sweep = (name: string, at: Date = new Date()) =>
    h.moduleRef.get(SweepRunner).run(name, at);

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    read = auditReaders(h);
    s = await d.setUp(3);
  }, 120_000);

  afterAll(() => h.close());

  async function single(
    action: string,
    targetId: string,
    tenantId = s.c.tenantId,
  ) {
    const rows = await read.tenant(tenantId, { action, targetId });
    expect(rows).toHaveLength(1);
    covered.add(action);
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain('29.98');
    return rows[0];
  }

  it('technician_location.consent_granted, .consent_revoked and .read — who, how many points, never where', async () => {
    const tech = s.techs[0];
    await d
      .http('post', '/technician/location-consent', tech.token)
      .expect(200);
    expect(
      await single('technician_location.consent_granted', tech.id),
    ).toMatchObject({ actorId: tech.id });
    const id = await d.openTicket(s);
    await d
      .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
        technicianId: tech.id,
      })
      .expect(204);
    await d
      .http('post', `/technician/tickets/${id}/en-route`, tech.token, {
        location: { latitude: 29.981234, longitude: 31.1 },
      })
      .expect(204);
    await d
      .http(
        'get',
        `/staff/field-team/technicians/${tech.id}/location`,
        s.supervisor.token,
      )
      .expect(200);
    expect(await single('technician_location.read', tech.id)).toMatchObject({
      actorId: s.supervisor.id,
      metadata: { found: true, moment: 'en_route' },
    });
    await d
      .http('delete', '/technician/location-consent', tech.token)
      .expect(200);
    expect(
      await single('technician_location.consent_revoked', tech.id),
    ).toMatchObject({ actorId: tech.id, metadata: { by: 'self', removed: 1 } });
  });

  it('staff_certificate.added, .changed, .removed and .erased — kinds, days, never its number', async () => {
    const holder = await d.who(
      s.c,
      (await d.g.guard(s.c, 'technician')).id,
      'staff',
    );
    const add = async () =>
      (
        (
          await d
            .http(
              'post',
              '/staff/field-team/certificates',
              s.supervisor.token,
              {
                accountId: holder.id,
                kind: 'gas',
                title: MARKER,
                reference: MARKER.slice(0, 20),
                expiresOn: day(100),
              },
            )
            .expect(201)
        ).body as { id: string }
      ).id;
    const id = await add();
    expect(await single('staff_certificate.added', id)).toMatchObject({
      actorId: s.supervisor.id,
      metadata: { holderId: holder.id, kind: 'gas', expiresOn: day(100) },
    });
    await d
      .http(
        'patch',
        `/staff/field-team/certificates/${id}`,
        s.supervisor.token,
        {
          title: `${MARKER} renewed`,
          expiresOn: day(200),
        },
      )
      .expect(200);
    expect(await single('staff_certificate.changed', id)).toMatchObject({
      metadata: {
        title: { changed: true },
        expiresOn: { from: day(100), to: day(200) },
      },
    });
    await d
      .http(
        'delete',
        `/staff/field-team/certificates/${id}`,
        s.supervisor.token,
      )
      .expect(204);
    expect(await single('staff_certificate.removed', id)).toMatchObject({
      metadata: { kind: 'gas' },
    });
    await add();
    await d.x.asManager(s.c, () =>
      h.moduleRef
        .get(AccountsService)
        .updateStatus(holder.id, { status: 'inactive' }),
    );
    await eraseNow(h, s.c, holder.id);
    expect(await single('staff_certificate.erased', holder.id)).toMatchObject({
      metadata: { removed: 2 },
    });
  });

  it('dangling_account.found, .kept, .deactivated and .cleared — the reason, the code, the finding', async () => {
    const quiet = (await d.g.guard(s.c, 'technician')).id;
    const gone = (await d.g.guard(s.c, 'technician')).id;
    const back = await d.who(
      s.c,
      (await d.g.guard(s.c, 'technician')).id,
      'staff',
    );

    // eslint-disable-next-line test-clock/day-multiple -- a real duration in ms: the sweep's own now and the rules it checks count 24-hour days
    await sweep(DANGLING_SWEEP, ahead(61 * DAY));
    const finding = async (accountId: string) =>
      (
        await d.inTenant(s.c, (tx) =>
          tx.danglingAccountFinding.findFirstOrThrow({
            where: { accountId, status: 'open' },
          }),
        )
      ).id;
    const q = await finding(quiet);
    expect(await single('dangling_account.found', quiet)).toMatchObject({
      actorType: 'system',
      metadata: { findingId: q, reason: 'never_signed_in' },
    });
    await d
      .http(
        'post',
        `/staff/access/dangling-accounts/${q}/keep`,
        s.manager.token,
        {
          reasonCode: 'seasonal_work',
        },
      )
      .expect(200);
    expect(await single('dangling_account.kept', quiet)).toMatchObject({
      actorId: s.c.managerId,
      metadata: { findingId: q, reasonCode: 'seasonal_work' },
    });
    const g = await finding(gone);
    await d
      .http(
        'post',
        `/staff/access/dangling-accounts/${g}/deactivate`,
        s.manager.token,
      )
      .expect(200);
    expect(await single('dangling_account.deactivated', gone)).toMatchObject({
      actorId: s.c.managerId,
      metadata: { findingId: g },
    });
    const b = await finding(back.id);
    await h.tokenFor({ sub: back.id, tid: s.c.tenantId, typ: 'staff' });
    await sweep(DANGLING_SWEEP);
    expect(await single('dangling_account.cleared', back.id)).toMatchObject({
      actorType: 'system',
      metadata: { findingId: b, why: 'active_again' },
    });
  });

  it('access_review.opened, .line_decided, .closed and .settings_changed — counts, the line, the decision', async () => {
    const c = await d.x.compound();
    const manager = await d.who(c, c.managerId, 'manager');
    const second = await d.who(
      c,
      (
        await h.createAccount(c.tenantId, {
          type: 'manager',
          email: uniqueEmail('audit-review'),
          phone: uniquePhone(),
        })
      ).id,
      'manager',
    );
    await d
      .http('patch', '/staff/access/settings', manager.token, {
        reviewEveryDays: 30,
      })
      .expect(200);
    expect(
      await single('access_review.settings_changed', c.tenantId, c.tenantId),
    ).toMatchObject({
      changes: { reviewEveryDays: { from: 90, to: 30 } },
    });

    // eslint-disable-next-line test-clock/day-multiple -- a real duration in ms: the sweep's own now and the rules it checks count 24-hour days
    await sweep(ACCESS_REVIEW_SWEEP, ahead(31 * DAY));
    const review = await d.inTenant(c, (tx) =>
      tx.accessReview.findFirstOrThrow({ where: { status: 'open' } }),
    );
    expect(
      await single('access_review.opened', review.id, c.tenantId),
    ).toMatchObject({
      actorType: 'system',
      metadata: { lines: 2, by: 'system' },
    });
    const lines = await d.inTenant(c, (tx) =>
      tx.accessReviewLine.findMany({ where: { reviewId: review.id } }),
    );
    const decide = (by: Who, lineId: string) =>
      d
        .http(
          'post',
          `/staff/access/reviews/${review.id}/lines/${lineId}/decide`,
          by.token,
          { decision: 'keep' },
        )
        .expect(200);
    const mine = lines.find((l) => l.accountId === manager.id)!;
    const theirs = lines.find((l) => l.accountId === second.id)!;
    await decide(manager, theirs.id);
    expect(
      await single('access_review.line_decided', review.id, c.tenantId),
    ).toMatchObject({
      actorId: manager.id,
      metadata: { lineId: theirs.id, accountId: second.id, decision: 'keep' },
    });
    await decide(second, mine.id);
    expect(
      await single('access_review.closed', review.id, c.tenantId),
    ).toMatchObject({ metadata: { kept: 2, revoked: 0, left: 0 } });
  });

  it('reinforcement_suggestion.suggested, .dismissed and .lapsed — the figures, the code', async () => {
    const pressure = (n: number | null) =>
      d
        .http('patch', '/maintenance/service-pressure', s.manager.token, {
          openPerTechnician: n,
        })
        .expect(200);
    const suggestion = async () =>
      (
        await d.inTenant(s.c, (tx) =>
          tx.reinforcementSuggestion.findFirstOrThrow({
            where: { status: 'open' },
          }),
        )
      ).id;
    const rise = async () => {
      await d.inTenant(s.c, (tx) =>
        tx.maintenanceServicePressure.updateMany({ data: { toldAt: null } }),
      );
      await sweep(SERVICE_PRESSURE_SWEEP);
    };
    await pressure(1);
    await d.openTicket(s);
    await rise();
    const first = await suggestion();
    expect(
      await single('reinforcement_suggestion.suggested', first),
    ).toMatchObject({
      actorType: 'system',
      metadata: { threshold: 1, available: expect.any(Number) as number },
    });
    await d
      .http(
        'post',
        `/staff/field-team/reinforcement-suggestions/${first}/dismiss`,
        s.supervisor.token,
        { reasonCode: 'nobody_to_call' },
      )
      .expect(200);
    expect(
      await single('reinforcement_suggestion.dismissed', first),
    ).toMatchObject({
      actorId: s.supervisor.id,
      metadata: { reasonCode: 'nobody_to_call' },
    });
    await rise();
    const second = await suggestion();
    await pressure(null);
    expect(
      await single('reinforcement_suggestion.lapsed', second),
    ).toBeDefined();
  });

  it('reinforcement_call.sent, .accepted, .declined, .filled, .cancelled and .closed — counts, ids, codes', async () => {
    const [, b, c] = s.techs;
    const send = async (needed: number, startH: number) =>
      (
        (
          await d
            .http(
              'post',
              '/staff/field-team/reinforcement-calls',
              s.supervisor.token,
              {
                needed,
                startsAt: ahead(startH * HOUR).toISOString(),
                endsAt: ahead((startH + 1) * HOUR).toISOString(),
              },
            )
            .expect(201)
        ).body as { id: string }
      ).id;
    const one = await send(1, 2);
    expect(await single('reinforcement_call.sent', one)).toMatchObject({
      actorId: s.supervisor.id,
      metadata: { needed: 1, recipients: expect.any(Number) as number },
    });
    await d
      .http('post', `/maintenance/reinforcement-calls/${one}/decline`, c.token)
      .expect(200);
    expect(await single('reinforcement_call.declined', one)).toMatchObject({
      actorId: c.id,
      metadata: { accountId: c.id },
    });
    await d
      .http('post', `/maintenance/reinforcement-calls/${one}/accept`, b.token)
      .expect(200);
    expect(await single('reinforcement_call.accepted', one)).toMatchObject({
      actorId: b.id,
      metadata: { accountId: b.id, slotId: expect.any(String) as string },
    });
    expect(await single('reinforcement_call.filled', one)).toMatchObject({
      metadata: { accepted: 1 },
    });
    const two = await send(2, 5);
    await d
      .http(
        'post',
        `/staff/field-team/reinforcement-calls/${two}/cancel`,
        s.supervisor.token,
        { reasonCode: 'raised_in_error' },
      )
      .expect(200);
    expect(await single('reinforcement_call.cancelled', two)).toMatchObject({
      actorId: s.supervisor.id,
      metadata: { reasonCode: 'raised_in_error', slotsCancelled: 0 },
    });
    const three = await send(2, 7);
    // Its start passed: as the database's clock has it.
    const db = new Client({
      connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
    });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query('SET LOCAL session_replication_role = replica');
      await db.query(
        `UPDATE reinforcement_calls SET sent_at = sent_at - interval '8 hours',
            starts_at = starts_at - interval '8 hours', ends_at = ends_at - interval '8 hours'
          WHERE id = $1`,
        [three],
      );
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
    await sweep(REINFORCEMENT_SWEEP);
    expect(await single('reinforcement_call.closed', three)).toMatchObject({
      actorType: 'system',
      metadata: { accepted: 0 },
    });
  });

  describe('catalog completeness', () => {
    it('every entry of the field team’s part b has a scenario above', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of FIELD_TEAM_B_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...FIELD_TEAM_B_COVERAGE].sort());
    });
  });
});
