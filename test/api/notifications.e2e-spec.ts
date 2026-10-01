import type { AccountType } from '@prisma/client';
import { AccountDeletionService } from '../../src/core/accounts/account-deletion.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import type { NotificationInput } from '../../src/core/notifications/notifier';
import { Notifier } from '../../src/core/notifications/notifier';
import { NOTIFICATIONS_RETENTION_SWEEP } from '../../src/core/notifications/notifications.service';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { buildWorld, type World } from './world';

const ITEM = [
  'createdAt',
  'id',
  'kind',
  'params',
  'params.gateName',
  'params.unitCode',
  'params.workerName',
  'priority',
  'readAt',
  'targetId',
  'targetType',
];

describe('API v0 — notifications inbox (ADR 0027)', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const entered = (targetId: string): NotificationInput => ({
    kind: 'worker.entered',
    params: { unitCode: 'A-1', gateName: 'Main', workerName: 'Amina' },
    targetId,
  });

  /** Writes notifications in A, in a transaction like a domain action. */
  const notify = (accountIds: string[], input: NotificationInput) =>
    w.helpers.asManager(w.a, () =>
      h.moduleRef
        .get(TenantTx)
        .withTenantTx((tx) =>
          h.moduleRef.get(Notifier).notify(tx, accountIds, input),
        ),
    );

  async function freshResident() {
    const unit = await w.helpers.unit(w.a);
    const r = await w.helpers.resident(w.a, [unit.id]);
    return { id: r.id, token: await w.tokenFor(w.a, r.id, 'resident') };
  }

  it('list, page, unread filter, counts, read one, read all', async () => {
    const me = await freshResident();
    const other = await freshResident();
    const target = w.bEngagementId; // any id: targets are not resolved
    await notify([me.id], entered(target));
    await notify([me.id], entered(target));
    await notify([me.id, me.id], {
      kind: 'gate.approval_requested',
      params: {
        unitCode: 'A-1',
        requestKind: 'uninvited_visitor',
        partySize: 2,
        gateName: 'Main',
        visitorName: 'Guest',
      },
      targetId: target,
    });
    await notify([other.id], entered(target));

    const count = () =>
      call(w, 'GET', '/me/notifications/unread-count', { token: me.token })
        .expect(200)
        .then((r) => r.body as { unread: number; critical: number });
    // Duplicate recipients are written once.
    expect(await count()).toEqual({ unread: 3, critical: 1 });

    const first = await call(w, 'GET', '/me/notifications', {
      token: me.token,
      query: { limit: '2' },
    }).expect(200);
    const page1 = first.body as {
      data: { id: string; kind: string; priority: string }[];
      nextCursor: string | null;
    };
    expect(page1.data.map((n) => n.kind)).toEqual([
      'gate.approval_requested',
      'worker.entered',
    ]);
    expect(page1.data[0].priority).toBe('critical');
    expect(page1.nextCursor).not.toBeNull();
    const second = await call(w, 'GET', '/me/notifications', {
      token: me.token,
      query: { limit: '2', cursor: page1.nextCursor! },
    }).expect(200);
    const page2 = second.body as { data: { id: string }[]; nextCursor: null };
    expect(keyPaths(page2)).toEqual(listKeys(ITEM));
    expect(page2.data).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();

    const readId = page2.data[0].id;
    await call(w, 'POST', `/me/notifications/${readId}/read`, {
      token: me.token,
    }).expect(204);
    // Idempotent.
    await call(w, 'POST', `/me/notifications/${readId}/read`, {
      token: me.token,
    }).expect(204);
    expect(await count()).toEqual({ unread: 2, critical: 1 });
    const unread = await call(w, 'GET', '/me/notifications', {
      token: me.token,
      query: { unread: 'true' },
    }).expect(200);
    expect(
      (unread.body as { data: { id: string }[] }).data.map((n) => n.id),
    ).not.toContain(readId);

    // Someone else's notification does not exist for me.
    const theirs = await call(w, 'GET', '/me/notifications', {
      token: other.token,
    }).expect(200);
    const theirId = (theirs.body as { data: { id: string }[] }).data[0].id;
    const res = await call(w, 'POST', `/me/notifications/${theirId}/read`, {
      token: me.token,
    });
    expect({ status: res.status, code: err(res).code }).toEqual({
      status: 404,
      code: 'NOTIFICATION_NOT_FOUND',
    });

    const all = await call(w, 'POST', '/me/notifications/read-all', {
      token: me.token,
    }).expect(200);
    expect(all.body).toEqual({ read: 2 });
    expect(await count()).toEqual({ unread: 0, critical: 0 });
    // Theirs is untouched.
    const theirCount = await call(w, 'GET', '/me/notifications/unread-count', {
      token: other.token,
    }).expect(200);
    expect(theirCount.body).toEqual({ unread: 1, critical: 0 });
  });

  it('the catalog is enforced at write time, and nothing is written outside a transaction', async () => {
    const me = await freshResident();
    await expect(
      notify([me.id], {
        kind: 'worker.entered',
        params: {
          unitCode: 'A-1',
          gateName: 'Main',
          workerName: 'X',
          phone: '1',
        },
        targetId: w.bEngagementId,
      }),
    ).rejects.toThrow(/no param phone/);
    await expect(
      h.moduleRef
        .get(Notifier)
        .notify({} as never, [me.id], entered(w.bEngagementId)),
    ).rejects.toThrow(/inside a TenantTx/);
  });

  it('a rolled-back action leaves no notification', async () => {
    const me = await freshResident();
    await expect(
      w.helpers.asManager(w.a, () =>
        h.moduleRef.get(TenantTx).withTenantTx(async (tx) => {
          await h.moduleRef
            .get(Notifier)
            .notify(tx, [me.id], entered(w.bEngagementId));
          throw new Error('the action failed');
        }),
      ),
    ).rejects.toThrow('the action failed');
    const res = await call(w, 'GET', '/me/notifications/unread-count', {
      token: me.token,
    }).expect(200);
    expect(res.body).toEqual({ unread: 0, critical: 0 });
  });

  it('scrubPersonal removes the names and keeps the rest', async () => {
    const me = await freshResident();
    const target = w.a.homeUnitId;
    await notify([me.id], entered(target));
    const scrubbed = await w.helpers.asManager(w.a, () =>
      h.moduleRef
        .get(TenantTx)
        .withTenantTx((tx) =>
          h.moduleRef.get(Notifier).scrubPersonal(tx, [target]),
        ),
    );
    expect(scrubbed).toBe(1);
    const res = await call(w, 'GET', '/me/notifications', {
      token: me.token,
    }).expect(200);
    expect((res.body as { data: { params: object }[] }).data[0].params).toEqual(
      { unitCode: 'A-1', gateName: 'Main' },
    );
  });

  it('retention purges read rows past the window and keeps unread ones', async () => {
    const me = await freshResident();
    await notify([me.id], entered(w.bEngagementId));
    await notify([me.id], entered(w.bEngagementId));
    const list = await call(w, 'GET', '/me/notifications', {
      token: me.token,
    }).expect(200);
    const [readOne] = (list.body as { data: { id: string }[] }).data;
    await call(w, 'POST', `/me/notifications/${readOne.id}/read`, {
      token: me.token,
    }).expect(204);
    const sweep = h.moduleRef.get(SweepRunner);
    // Inside the window: nothing goes.
    await sweep.run(NOTIFICATIONS_RETENTION_SWEEP, new Date());
    const now = await call(w, 'GET', '/me/notifications', {
      token: me.token,
    }).expect(200);
    expect((now.body as { data: unknown[] }).data).toHaveLength(2);
    // 91 days on, the read one goes, the unread one stays.
    await sweep.run(
      NOTIFICATIONS_RETENTION_SWEEP,
      new Date(Date.now() + 91 * 86_400_000),
    );
    const later = await call(w, 'GET', '/me/notifications', {
      token: me.token,
    }).expect(200);
    const left = (later.body as { data: { id: string; readAt: null }[] }).data;
    expect(left).toHaveLength(1);
    expect(left[0].id).not.toBe(readOne.id);
    expect(left[0].readAt).toBeNull();
  });

  it('an erased account keeps no notification', async () => {
    const me = await freshResident();
    await notify([me.id], entered(w.bEngagementId));
    const deletion = h.moduleRef.get(AccountDeletionService);
    const type: AccountType = 'resident';
    const request = await w.helpers.as(w.a, { id: me.id, type }, () =>
      deletion.requestDeletion('DELETE'),
    );
    await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.accountDeletionRequest.update({
        where: { id: request.id },
        data: {
          requestedAt: new Date(Date.now() - 31 * 86_400_000),
          effectiveAt: new Date(Date.now() - 86_400_000),
        },
      }),
    );
    const scope = await call(w, 'GET', `/erasures/${request.id}/scope`, {
      token: w.a.tokens.manager,
    }).expect(200);
    await call(w, 'POST', `/erasures/${request.id}/erase`, {
      token: w.a.tokens.manager,
      body: { typedScope: (scope.body as { scopePhrase: string }).scopePhrase },
    }).expect(204);
    const left = await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.notification.count({
        where: { accountId: me.id },
      }),
    );
    expect(left).toBe(0);
  });
});
