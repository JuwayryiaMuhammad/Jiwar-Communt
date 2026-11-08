import { Client } from 'pg';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { SERVICE_PRESSURE_SWEEP } from '../../src/maintenance/dispatch/service-pressure';
import { REINFORCEMENT_SWEEP } from '../../src/maintenance/reinforcement/reinforcement.service';
import { auditReaders } from '../setup/audit';
import { dispatchHelpers } from '../setup/dispatch';
import { engagementHelpers } from '../setup/engagement';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { required } from '../setup/test-env';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface Call {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  needed: number;
  accepted: number;
  recipientCount: number;
  recipients:
    | {
        technician: { id: string };
        answer: string | null;
        slotId: string | null;
      }[]
    | null;
  myAnswer: string | null;
  suggestionId: string | null;
}
interface Suggestion {
  id: string;
  status: string;
  openTickets: number;
  available: number;
  callId: string | null;
}

const code = (res: { status: number; body: unknown }) => ({
  status: res.status,
  code: (res.body as { code?: string }).code,
  params: (res.body as { params?: unknown }).params,
});

/** An ISO instant `ms` from now: a call's window. */

const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

/**
 * TEST-ONLY time machine: moves a call's send and start `ms` into the past
 * over a superuser connection that skips the trigger keeping them.
 */
async function rewindCall(id: string, ms: number): Promise<void> {
  const db = new Client({
    connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
  });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL session_replication_role = replica');
    await db.query(
      `UPDATE reinforcement_calls
          SET sent_at = sent_at - $2::interval, starts_at = starts_at - $2::interval,
              ends_at = ends_at - $2::interval
        WHERE id = $1`,
      [id, `${ms} milliseconds`],
    );
    await db.query('COMMIT');
  } finally {
    await db.end();
  }
}

/**
 * ADR 0090: service pressure suggests reinforcement; the field team calls
 * the technicians off duty for a window; each accepting writes a roster
 * slot (an overlap refused); the call is filled, closed at its start or
 * called off once, and nothing reaches anyone off duty by itself.
 */
describe('Peak reinforcement', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let audit: ReturnType<typeof auditReaders>;
  const told = async (accountId: string, targetId: string) =>
    (await engagementHelpers(h).notifications(s.c, accountId))
      .filter((n) => n.targetId === targetId)
      .map((n) => n.kind);

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(4);
    audit = auditReaders(h);
  }, 120_000);

  afterAll(() => h.close());

  const send = (body: object = {}) =>
    d.http(
      'post',
      '/staff/field-team/reinforcement-calls',
      s.supervisor.token,
      {
        needed: 2,
        startsAt: ahead(HOUR),
        endsAt: ahead(5 * HOUR),
        ...body,
      },
    );
  const answer = (as: Who, id: string, what: 'accept' | 'decline') =>
    d.http('post', `/maintenance/reinforcement-calls/${id}/${what}`, as.token);
  const get = async (id: string) =>
    (
      await d
        .http(
          'get',
          `/staff/field-team/reinforcement-calls/${id}`,
          s.supervisor.token,
        )
        .expect(200)
    ).body as Call;

  it('service pressure suggests, once; the field team is told and has it in the inbox; eased, it lapses', async () => {
    const pressure = (n: number | null) =>
      d
        .http('patch', '/maintenance/service-pressure', s.manager.token, {
          openPerTechnician: n,
        })
        .expect(200);
    await pressure(1);
    await d.openTicket(s);
    const sweep = () =>
      h.moduleRef.get(SweepRunner).run(SERVICE_PRESSURE_SWEEP, new Date());
    await sweep();
    await sweep();
    const list = async () =>
      (
        (
          await d
            .http(
              'get',
              '/staff/field-team/reinforcement-suggestions',
              s.supervisor.token,
            )
            .expect(200)
        ).body as { data: Suggestion[] }
      ).data;
    const [open] = await list();
    expect(open).toMatchObject({ status: 'open', available: 0 });
    expect(await list()).toHaveLength(1);
    expect(await told(s.supervisor.id, open.id)).toEqual([
      'reinforcement.suggested',
    ]);
    // Nothing reached a technician.
    for (const t of s.techs)
      expect(
        (await engagementHelpers(h).notifications(s.c, t.id)).map(
          (n) => n.kind,
        ),
      ).not.toContain('reinforcement.called');
    const inbox = (
      await d
        .http(
          'get',
          '/staff/inbox?type=reinforcement_suggestion',
          s.supervisor.token,
        )
        .expect(200)
    ).body as { data: { id: string }[] };
    expect(inbox.data.map((r) => r.id)).toEqual([open.id]);
    await pressure(null);
    expect((await list())[0]).toMatchObject({ id: open.id, status: 'lapsed' });
  });

  it('a call reaches those off duty only, critically; accepting writes a slot; the last one needed fills it', async () => {
    const [a, b, onDuty, late] = s.techs;
    await d
      .http('post', '/technician/availability', onDuty.token, {
        state: 'available',
      })
      .expect(200);
    const call = (await send().expect(201)).body as Call;
    expect(call).toMatchObject({ status: 'open', needed: 2, accepted: 0 });
    const reached = call.recipients!.map((r) => r.technician.id);
    expect(reached).toEqual(expect.arrayContaining([a.id, b.id, late.id]));
    expect(reached).not.toContain(onDuty.id);
    expect(await told(a.id, call.id)).toEqual(['reinforcement.called']);
    expect(code(await answer(onDuty, call.id, 'accept'))).toMatchObject({
      status: 404,
      code: 'REINFORCEMENT_CALL_NOT_FOUND',
    });
    const accepted = (await answer(a, call.id, 'accept').expect(200))
      .body as Call;
    expect(accepted).toMatchObject({ accepted: 1, myAnswer: 'accepted' });
    expect(code(await answer(a, call.id, 'decline'))).toMatchObject({
      status: 409,
      code: 'REINFORCEMENT_ANSWERED',
    });
    const slot = await d.inTenant(s.c, async (tx) => {
      const r = await tx.reinforcementCallRecipient.findFirstOrThrow({
        where: { callId: call.id, accountId: a.id },
      });
      return tx.guardRosterSlot.findUniqueOrThrow({ where: { id: r.slotId! } });
    });
    expect(slot).toMatchObject({
      crew: 'maintenance',
      guardAccountId: a.id,
      status: 'scheduled',
      createdById: s.supervisor.id,
    });
    expect([slot.startsAt.toISOString(), slot.endsAt.toISOString()]).toEqual([
      call.startsAt,
      call.endsAt,
    ]);
    await answer(b, call.id, 'accept').expect(200);
    expect(await get(call.id)).toMatchObject({ status: 'filled', accepted: 2 });
    expect(await told(s.supervisor.id, call.id)).toEqual([
      'reinforcement.filled',
    ]);
    expect(code(await answer(late, call.id, 'accept'))).toMatchObject({
      status: 409,
      code: 'REINFORCEMENT_CALL_CLOSED',
      params: { status: 'filled' },
    });
    // Its own: the technician lists the calls that reached them.
    const mine = (
      await d
        .http('get', '/maintenance/reinforcement-calls', a.token)
        .expect(200)
    ).body as { data: Call[] };
    expect(mine.data.find((c) => c.id === call.id)).toMatchObject({
      myAnswer: 'accepted',
      recipients: null,
    });
  });

  it('an overlap is refused and nothing is recorded; called off, the accepted slots go and the others are told; closed at its start', async () => {
    const [a, b, , late] = s.techs;
    // `a` holds the earlier call's slot, one to five hours ahead.
    const clash = (await send({ needed: 1 }).expect(201)).body as Call;
    expect(code(await answer(a, clash.id, 'accept'))).toMatchObject({
      status: 409,
      code: 'ROSTER_OVERLAP',
    });
    expect(
      (await get(clash.id)).recipients!.find((r) => r.technician.id === a.id),
    ).toMatchObject({ answer: null });

    const later = (
      await send({
        needed: 3,
        startsAt: ahead(6 * HOUR),
        endsAt: ahead(8 * HOUR),
      }).expect(201)
    ).body as Call;
    await answer(a, later.id, 'accept').expect(200);
    await answer(b, later.id, 'decline').expect(200);
    const cancelled = await d
      .http(
        'post',
        `/staff/field-team/reinforcement-calls/${later.id}/cancel`,
        s.supervisor.token,
        { reasonCode: 'pressure_eased' },
      )
      .expect(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled' });
    const slotId = (await get(later.id)).recipients!.find(
      (r) => r.technician.id === a.id,
    )!.slotId!;
    expect(
      (
        await d.inTenant(s.c, (tx) =>
          tx.guardRosterSlot.findUniqueOrThrow({ where: { id: slotId } }),
        )
      ).status,
    ).toBe('cancelled');
    expect(await told(a.id, later.id)).toEqual([
      'reinforcement.called',
      'reinforcement.cancelled',
    ]);
    expect(await told(late.id, later.id)).toEqual([
      'reinforcement.called',
      'reinforcement.cancelled',
    ]);
    expect(await told(b.id, later.id)).toEqual(['reinforcement.called']);
    expect(
      (
        await audit.tenant(s.c.tenantId, {
          action: 'reinforcement_call.cancelled',
          targetId: later.id,
        })
      )[0],
    ).toMatchObject({
      metadata: { reasonCode: 'pressure_eased', slotsCancelled: 1 },
    });

    // The clash's call closes at its start, by the database's clock: a
    // sweep as of later finds its start still ahead and leaves it.
    const sweep = (at: Date) =>
      h.moduleRef.get(SweepRunner).run(REINFORCEMENT_SWEEP, at);

    await sweep(new Date(Date.now() + 2 * HOUR));
    expect((await get(clash.id)).status).toBe('open');
    await rewindCall(clash.id, 2 * HOUR);
    await sweep(new Date());
    expect(await get(clash.id)).toMatchObject({ status: 'closed' });
    expect(code(await answer(late, clash.id, 'accept'))).toMatchObject({
      status: 409,
      code: 'REINFORCEMENT_CALL_CLOSED',
    });
  });

  it('the window and the count are bounded; a suggestion is answered by the call', async () => {
    for (const body of [
      { needed: 0 },
      { needed: 11 },
      { startsAt: ahead(5 * MINUTE), endsAt: ahead(2 * HOUR) },
      { startsAt: ahead(13 * HOUR), endsAt: ahead(14 * HOUR) },
      { startsAt: ahead(HOUR), endsAt: ahead(HOUR + 30 * MINUTE) },
      { startsAt: ahead(HOUR), endsAt: ahead(14 * HOUR) },
    ])
      expect((await send(body)).status).toBe(400);
    await d
      .http('patch', '/maintenance/service-pressure', s.manager.token, {
        openPerTechnician: 1,
      })
      .expect(200);
    await d.openTicket(s);
    // The first rise was told within the hour: one notice an hour at most
    // (ADR 0079), and the suggestion with it. Past the hour, as setup.
    await d.inTenant(s.c, (tx) =>
      tx.maintenanceServicePressure.update({
        where: { tenantId: s.c.tenantId },
        data: { toldAt: null },
      }),
    );
    await h.moduleRef.get(SweepRunner).run(SERVICE_PRESSURE_SWEEP, new Date());
    const [open] = (
      (
        await d
          .http(
            'get',
            '/staff/field-team/reinforcement-suggestions?status=open',
            s.supervisor.token,
          )
          .expect(200)
      ).body as { data: Suggestion[] }
    ).data;
    const call = (
      await send({
        needed: 1,
        suggestionId: open.id,
        startsAt: ahead(9 * HOUR),
        endsAt: ahead(10 * HOUR),
      }).expect(201)
    ).body as Call;
    expect(call.suggestionId).toBe(open.id);
    const after = (
      (
        await d
          .http(
            'get',
            '/staff/field-team/reinforcement-suggestions',
            s.supervisor.token,
          )
          .expect(200)
      ).body as { data: Suggestion[] }
    ).data.find((x) => x.id === open.id);
    expect(after).toMatchObject({ status: 'answered', callId: call.id });
    expect(code(await send({ suggestionId: open.id }))).toMatchObject({
      status: 409,
      code: 'REINFORCEMENT_SUGGESTION_DECIDED',
    });
  });
});
