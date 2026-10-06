import {
  AccountDeletionService,
  scopePhrase,
} from '../../src/core/accounts/account-deletion.service';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

type SetUp = Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
type Who = { id: string; token: string };

/**
 * ADR 0032: an emergency, at creation or by a change, sends a critical
 * notice to every active `tickets.dispatch` holder of the compound except
 * the account that performed the action — and to nobody else.
 */
describe('Maintenance — emergency fan-out', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: SetUp;
  let other: SetUp;
  /** A second supervisor: another holder. */
  let supervisor2: Who;
  /** Holders who no longer act: never told. */
  let frozen: string;
  let erased: string;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    other = await d.setUp(1);
    supervisor2 = await d.who(
      s.c,
      (await d.g.guard(s.c, 'maintenance_supervisor')).id,
      'staff',
    );
    // Everyone else who could be told, and must not be: a family member, a
    // landlord of the unit, a guard (the technician and the reporter exist).
    await d.x.joinFamily(s.c, s.unit.id, s.owner);
    await d.x.asManager(s.c, () =>
      d.x.residents.createResident({
        ...d.x.person('landlord'),
        units: [{ unitId: s.unit.id, occupancyType: 'owner', resides: false }],
      }),
    );
    await d.g.guard(s.c);

    frozen = (await d.g.guard(s.c, 'maintenance_supervisor')).id;
    await d.x.asManager(s.c, () =>
      h.moduleRef.get(AccountsService).freeze(frozen, {
        code: 'phone_reassigned',
        text: 'Number reassigned',
      }),
    );
    erased = (await d.g.guard(s.c, 'maintenance_supervisor')).id;
    const deletion = h.moduleRef.get(AccountDeletionService);
    const request = await d.x.as(s.c, { id: erased, type: 'staff' }, () =>
      deletion.requestDeletion('DELETE'),
    );
    await d.x.asManager(s.c, () =>
      d.x.prisma.tenant.accountDeletionRequest.update({
        where: { id: request.id },
        data: {
          requestedAt: new Date(Date.now() - 31 * 86_400_000),
          effectiveAt: new Date(Date.now() - 86_400_000),
        },
      }),
    );
    await d.x.asManager(s.c, () =>
      deletion.erase(request.id, scopePhrase(erased)),
    );
  }, 120_000);

  afterAll(() => h.close());

  /** Who was told of the ticket's emergency, sorted. */
  const told = (ticketId: string) =>
    d.inTenant(s.c, async (tx) =>
      (
        await tx.notification.findMany({
          where: { targetId: ticketId, kind: 'ticket.emergency' },
        })
      ).map((n) => {
        expect(n.priority).toBe('critical');
        return n.accountId;
      }),
    );

  const holders = () => [s.c.managerId, s.supervisor.id, supervisor2.id];
  const sorted = (ids: string[]) => [...ids].sort();

  /** No emergency notice anywhere in the other compound. */
  const otherCompoundQuiet = async () =>
    expect(
      await d.inTenant(other.c, (tx) =>
        tx.notification.count({ where: { kind: 'ticket.emergency' } }),
      ),
    ).toBe(0);

  it('opened by a resident: every active holder, and nobody else', async () => {
    const id = await d.openTicket(s, { priority: 'emergency' });
    expect(sorted(await told(id))).toEqual(sorted(holders()));
    await otherCompoundQuiet();
  });

  it('opened by a dispatcher on a resident’s behalf: every other active holder, not the dispatcher', async () => {
    const opened = await d
      .http('post', '/maintenance/tickets', s.supervisor.token, {
        unitId: s.unit.id,
        categoryId: await d.categoryId(s.c, 'general'),
        description: 'Emergency on behalf',
        priority: 'emergency',
        reporterAccountId: s.owner.id,
      })
      .expect(201);
    const id = (opened.body as { id: string }).id;
    expect(sorted(await told(id))).toEqual(
      sorted(holders().filter((x) => x !== s.supervisor.id)),
    );
    await otherCompoundQuiet();
  });

  it('raised to emergency by a dispatcher: every other active holder, not the dispatcher', async () => {
    const id = await d.openTicket(s);
    expect(await told(id)).toEqual([]);
    await d
      .http('post', `/maintenance/tickets/${id}/priority`, s.manager.token, {
        priority: 'emergency',
        reasonCode: 'safety_risk',
      })
      .expect(204);
    expect(sorted(await told(id))).toEqual(
      sorted(holders().filter((x) => x !== s.c.managerId)),
    );
    await otherCompoundQuiet();
  });

  it('the frozen and the erased holder are never told', async () => {
    const id = await d.openTicket(s, { priority: 'emergency' });
    const ids = await told(id);
    expect(ids).not.toContain(frozen);
    expect(ids).not.toContain(erased);
  });
});
