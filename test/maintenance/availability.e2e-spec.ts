import {
  AccountDeletionService,
  scopePhrase,
} from '../../src/core/accounts/account-deletion.service';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { dispatchHelpers } from '../setup/dispatch';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0033: a technician's availability — opt-in, set by the technician or
 * by a dispatcher with a reason, never edited in its history, and cleared
 * by deactivation, a freeze and an erasure.
 */
describe('Maintenance — technician availability', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(4);
  }, 60_000);

  afterAll(() => h.close());

  const mine = async (token: string) =>
    (await d.http('get', '/technician/availability', token).expect(200))
      .body as {
      state: string;
      since: string | null;
    };
  const history = (accountId: string) =>
    d.inTenant(s.c, (tx) =>
      tx.technicianAvailabilityHistory.findMany({
        where: { accountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  const listed = async (id: string) =>
    (
      (
        await d
          .http('get', '/maintenance/technicians', s.supervisor.token)
          .expect(200)
      ).body as {
        data: {
          id: string;
          availability: { state: string; since: string | null };
        }[];
      }
    ).data.find((t) => t.id === id);

  it('no row means unavailable: a technician opts in', async () => {
    const tech = s.techs[0];
    expect(await mine(tech.token)).toEqual({
      state: 'unavailable',
      since: null,
    });
    expect((await listed(tech.id))!.availability).toEqual({
      state: 'unavailable',
      since: null,
    });
    // Saying "unavailable" again changes nothing, not even a row.
    await d
      .http('post', '/technician/availability', tech.token, {
        state: 'unavailable',
      })
      .expect(200);
    expect(await history(tech.id)).toHaveLength(0);
  });

  it('the technician goes available and back; every change is in the history', async () => {
    const tech = s.techs[0];
    const on = await d
      .http('post', '/technician/availability', tech.token, {
        state: 'available',
      })
      .expect(200);
    expect(on.body).toMatchObject({ state: 'available' });
    expect((on.body as { since: string }).since).toEqual(expect.any(String));
    // Again: no new row.
    await d
      .http('post', '/technician/availability', tech.token, {
        state: 'available',
      })
      .expect(200);
    await d
      .http('post', '/technician/availability', tech.token, {
        state: 'unavailable',
      })
      .expect(200);
    expect(
      (await history(tech.id)).map((r) => [
        r.fromState,
        r.toState,
        r.changedById,
        r.reasonCode,
      ]),
    ).toEqual([
      [null, 'available', tech.id, null],
      ['available', 'unavailable', tech.id, null],
    ]);
    expect((await listed(tech.id))!.availability.state).toBe('unavailable');
  });

  it('a dispatcher sets it with a reason code, which is required and from the list', async () => {
    const tech = s.techs[1];
    const missing = await d
      .http(
        'post',
        `/maintenance/technicians/${tech.id}/availability`,
        s.supervisor.token,
        {
          state: 'available',
        },
      )
      .expect(400);
    expect(missing.body).toMatchObject({ code: 'REASON_REQUIRED' });
    const wrong = await d
      .http(
        'post',
        `/maintenance/technicians/${tech.id}/availability`,
        s.supervisor.token,
        {
          state: 'available',
          reasonCode: 'bored',
        },
      )
      .expect(400);
    expect(wrong.body).toMatchObject({
      fields: [
        {
          field: 'reasonCode',
          code: 'INVALID_REASON_CODE',
          params: { allowed: ['sick', 'leave', 'training', 'other'] },
        },
      ],
    });
    await d
      .http(
        'post',
        `/maintenance/technicians/${tech.id}/availability`,
        s.supervisor.token,
        {
          state: 'available',
          reasonCode: 'training',
        },
      )
      .expect(200);
    expect(
      (await history(tech.id)).map((r) => [
        r.toState,
        r.changedById,
        r.reasonCode,
      ]),
    ).toEqual([['available', s.supervisor.id, 'training']]);
    // The technician sees the dispatcher's change as their own state.
    expect((await mine(tech.token)).state).toBe('available');
  });

  it('only technicians have availability: anyone else is TECHNICIAN_NOT_FOUND, and a technician cannot reach another’s', async () => {
    for (const id of [s.owner.id, s.supervisor.id]) {
      const res = await d
        .http(
          'post',
          `/maintenance/technicians/${id}/availability`,
          s.supervisor.token,
          {
            state: 'available',
            reasonCode: 'other',
          },
        )
        .expect(404);
      expect(res.body).toMatchObject({ code: 'TECHNICIAN_NOT_FOUND' });
    }
    await d
      .http(
        'post',
        `/maintenance/technicians/${s.techs[1].id}/availability`,
        s.techs[0].token,
        {
          state: 'unavailable',
          reasonCode: 'sick',
        },
      )
      .expect(403);
  });

  it('deactivation, a freeze and an erasure make a technician unavailable, with a system history row; reactivation does not undo it', async () => {
    const accounts = h.moduleRef.get(AccountsService);
    const cases = [
      { tech: s.techs[2], reason: 'account_deactivated' },
      { tech: s.techs[3], reason: 'account_frozen' },
    ];
    for (const { tech } of cases)
      await d
        .http('post', '/technician/availability', tech.token, {
          state: 'available',
        })
        .expect(200);
    await d.x.asManager(s.c, () =>
      accounts.updateStatus(s.techs[2].id, { status: 'inactive' }),
    );
    await d.x.asManager(s.c, () =>
      accounts.freeze(s.techs[3].id, {
        code: 'phone_reassigned',
        text: 'Test',
      }),
    );
    for (const { tech, reason } of cases) {
      const rows = await history(tech.id);
      expect(rows.at(-1)).toMatchObject({
        fromState: 'available',
        toState: 'unavailable',
        changedById: null,
        reasonCode: reason,
      });
      const state = await d.inTenant(s.c, (tx) =>
        tx.technicianAvailability.findFirstOrThrow({
          where: { accountId: tech.id },
        }),
      );
      expect(state.state).toBe('unavailable');
    }
    // Back to active: still unavailable until the technician opts in.
    await d.x.asManager(s.c, () =>
      accounts.updateStatus(s.techs[2].id, { status: 'active' }),
    );
    const again = await d.inTenant(s.c, (tx) =>
      tx.technicianAvailability.findFirstOrThrow({
        where: { accountId: s.techs[2].id },
      }),
    );
    expect(again.state).toBe('unavailable');
  });

  it('a technician who asks to be erased is unavailable by the end of it (the request deactivates the account first)', async () => {
    const leaving = await d.who(
      s.c,
      (await d.g.guard(s.c, 'technician')).id,
      'staff',
    );
    await d
      .http('post', '/technician/availability', leaving.token, {
        state: 'available',
      })
      .expect(200);
    const deletion = h.moduleRef.get(AccountDeletionService);
    const request = await d.x.as(s.c, { id: leaving.id, type: 'staff' }, () =>
      deletion.requestDeletion('DELETE'),
    );
    await d.inTenant(s.c, (tx) =>
      tx.accountDeletionRequest.update({
        where: { id: request.id },
        data: {
          requestedAt: new Date(Date.now() - 31 * 86_400_000),
          effectiveAt: new Date(Date.now() - 86_400_000),
        },
      }),
    );
    await d.x.asManager(s.c, () =>
      deletion.erase(request.id, scopePhrase(leaving.id)),
    );
    const rows = await history(leaving.id);
    expect(rows.at(-1)).toMatchObject({
      fromState: 'available',
      toState: 'unavailable',
      changedById: null,
    });
    // Whichever step got there first said why; none is left available.
    expect(['account_deactivated', 'account_erased']).toContain(
      rows.at(-1)!.reasonCode,
    );
    expect(rows).toHaveLength(2);
  });
});
