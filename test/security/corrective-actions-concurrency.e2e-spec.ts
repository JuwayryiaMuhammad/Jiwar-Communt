import { dbClock, day } from '../setup/compound-clock';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { securityOpsHelpers } from '../setup/security-ops';

const ROUNDS = 5;

/**
 * ADR 0087, a close against a new corrective action. The close takes the
 * incident FOR UPDATE and counts its open actions; a new action takes it
 * FOR SHARE and is refused once it is closed. So they meet in one order:
 * the action came first and the close is refused (INCIDENT_ACTIONS_OPEN),
 * or the close came first and the action is refused (INCIDENT_CLOSED).
 * Never a closed incident with an open action.
 */
describe('Corrective actions — races', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof securityOpsHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof securityOpsHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = securityOpsHelpers(h);
    s = await x.setUp('Corrective Race Court');
  }, 180_000);

  afterAll(() => h.close());

  const m = () => s.manager.token;

  it('R1: a close and a new action at once: one wins, never closed with an action open (×5)', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const i = (
        await x
          .http('post', '/staff/security/incidents', m(), {
            type: 'near_miss',
            severity: 'low',
            unitCode: s.home.code,
            occurredAt: new Date(dbClock().getTime() - 600_000).toISOString(),
            description: 'A slip by the pool',
          })
          .expect(201)
      ).body as { id: string };
      const [closed, added] = await Promise.all([
        x.http('post', `/staff/security/incidents/${i.id}/close`, m(), {
          reasonCode: 'resolved',
          note: 'Done',
        }),
        x.http('post', `/staff/security/incidents/${i.id}/actions`, m(), {
          description: 'Put a mat down',
          ownerId: s.manager.id,
          dueOn: day(3),
        }),
      ]);
      const row = await x.inTx(s.c, (tx) =>
        tx.incident.findUniqueOrThrow({ where: { id: i.id } }),
      );
      const open = await x.inTx(s.c, (tx) =>
        tx.incidentAction.count({
          where: { incidentId: i.id, status: 'open' },
        }),
      );
      if (closed.status === 200) {
        expect(added.status).toBe(409);
        expect(added.body).toMatchObject({ code: 'INCIDENT_CLOSED' });
        expect(row.status).toBe('closed');
        expect(open).toBe(0);
      } else {
        expect(closed.status).toBe(409);
        expect(closed.body).toMatchObject({
          code: 'INCIDENT_ACTIONS_OPEN',
          params: { open: 1 },
        });
        expect(added.status).toBe(201);
        expect(row.status).not.toBe('closed');
        expect(open).toBe(1);
      }
    }
  });
});
