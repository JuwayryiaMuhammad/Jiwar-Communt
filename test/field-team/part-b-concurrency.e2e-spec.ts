import { AccountsService } from '../../src/core/accounts/accounts.service';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

const HOUR = 3_600_000;
const HERE = { latitude: 30.05, longitude: 31.25 };

/** An ISO instant `ms` from now: a call's window. */

const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();

/**
 * ADR 0090, its races (×5 each): two consents at once; a step's point
 * against the consent's revocation; two acceptances for the last place of
 * a call, and an acceptance against a call-off; two decisions of one
 * access review line, and a revocation against a plain deactivation of the
 * same account.
 */
describe('The field team, part b — concurrency', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(0);
  }, 120_000);

  afterAll(() => h.close());

  const technician = async (): Promise<Who> =>
    d.who(s.c, (await d.g.guard(s.c, 'technician')).id, 'staff');
  const consent = (as: Who, method: 'post' | 'delete') =>
    d.http(method, '/technician/location-consent', as.token);
  it('two consents at once: one live consent', async () => {
    for (let i = 0; i < 5; i++) {
      const tech = await technician();
      const res = await Promise.all([
        consent(tech, 'post'),
        consent(tech, 'post'),
      ]);
      expect(res.map((r) => r.status)).toEqual([200, 200]);
      expect(
        await d.inTenant(s.c, (tx) =>
          tx.technicianLocationConsent.count({
            where: { accountId: tech.id },
          }),
        ),
      ).toBe(1);
    }
  });

  it('a step’s point against the revocation: no point outlives the consent', async () => {
    for (let i = 0; i < 5; i++) {
      const tech = await technician();
      await consent(tech, 'post').expect(200);
      const id = await d.openTicket(s);
      await d
        .http('post', `/maintenance/tickets/${id}/assign`, s.supervisor.token, {
          technicianId: tech.id,
        })
        .expect(204);
      const [step] = await Promise.all([
        d.http('post', `/technician/tickets/${id}/en-route`, tech.token, {
          location: HERE,
        }),
        consent(tech, 'delete'),
      ]);
      expect([204, 409]).toContain(step.status);
      expect(
        await d.inTenant(s.c, (tx) =>
          tx.technicianLocation.count({ where: { accountId: tech.id } }),
        ),
      ).toBe(0);
      expect((await d.ticketRow(s.c, id)).status).toBe(
        step.status === 204 ? 'en_route' : 'assigned',
      );
    }
  });

  it('two acceptances for the last place: one slot; an acceptance against a call-off: never an open slot of a cancelled call', async () => {
    for (let i = 0; i < 5; i++) {
      const a = await technician();
      const b = await technician();
      const call = (
        await d
          .http(
            'post',
            '/staff/field-team/reinforcement-calls',
            s.supervisor.token,
            { needed: 1, startsAt: ahead(HOUR), endsAt: ahead(3 * HOUR) },
          )
          .expect(201)
      ).body as { id: string };
      const res = await Promise.all(
        [a, b].map((t) =>
          d.http(
            'post',
            `/maintenance/reinforcement-calls/${call.id}/accept`,
            t.token,
          ),
        ),
      );
      expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
      const slots = await d.inTenant(s.c, (tx) =>
        tx.reinforcementCallRecipient.count({
          where: { callId: call.id, slotId: { not: null } },
        }),
      );
      expect(slots).toBe(1);

      const c = await technician();
      const other = (
        await d
          .http(
            'post',
            '/staff/field-team/reinforcement-calls',
            s.supervisor.token,
            { needed: 2, startsAt: ahead(5 * HOUR), endsAt: ahead(7 * HOUR) },
          )
          .expect(201)
      ).body as { id: string };
      await Promise.all([
        d.http(
          'post',
          `/maintenance/reinforcement-calls/${other.id}/accept`,
          c.token,
        ),
        d.http(
          'post',
          `/staff/field-team/reinforcement-calls/${other.id}/cancel`,
          s.supervisor.token,
          { reasonCode: 'no_longer_needed' },
        ),
      ]);
      const left = await d.inTenant(s.c, async (tx) => {
        const r = await tx.reinforcementCallRecipient.findFirst({
          where: { callId: other.id, accountId: c.id },
        });
        return r?.slotId
          ? (
              await tx.guardRosterSlot.findUniqueOrThrow({
                where: { id: r.slotId },
              })
            ).status
          : null;
      });
      expect([null, 'cancelled']).toContain(left);
    }
  });

  it('two decisions of one line: one wins; a revocation against a deactivation: decided once, the account inactive', async () => {
    for (let i = 0; i < 5; i++) {
      // A compound of its own each round: one review open at a time.
      const c = await d.x.compound();
      const manager = await d.who(c, c.managerId, 'manager');
      const a = (await d.g.guard(c, 'technician')).id;
      const b = (await d.g.guard(c, 'technician')).id;
      const review = (
        await d.http('post', '/staff/access/reviews', manager.token).expect(201)
      ).body as {
        id: string;
        reviewLines: { id: string; account: { id: string } }[];
      };
      const line = (id: string) =>
        review.reviewLines.find((l) => l.account.id === id)!.id;
      const decide = (lineId: string, decision: string) =>
        d.http(
          'post',
          `/staff/access/reviews/${review.id}/lines/${lineId}/decide`,
          manager.token,
          { decision },
        );
      const res = await Promise.all([
        decide(line(a), 'keep'),
        decide(line(a), 'revoke'),
      ]);
      expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
      const [decided] = await Promise.all([
        decide(line(b), 'revoke'),
        d.x.asManager(c, () =>
          h.moduleRef
            .get(AccountsService)
            .updateStatus(b, { status: 'inactive' }),
        ),
      ]);
      expect([200, 409]).toContain(decided.status);
      const row = await d.inTenant(c, (tx) =>
        tx.accessReviewLine.findUniqueOrThrow({ where: { id: line(b) } }),
      );
      expect(row.decision).toBe(decided.status === 200 ? 'revoke' : 'left');
      expect(
        (
          await d.inTenant(c, (tx) =>
            tx.account.findUniqueOrThrow({ where: { id: b } }),
          )
        ).status,
      ).toBe('inactive');
    }
  });
});
