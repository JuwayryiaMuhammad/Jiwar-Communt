import { AccountDeletionService } from '../../src/core/accounts/account-deletion.service';
import type { AccountType } from '@prisma/client';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { call } from './request';
import { newManagerBody } from './routes/platform';
import { workerBody } from './routes/workers';
import { buildWorld, type World } from './world';

/** An erased account renders as `{ id, erased: true }` wherever an account appears (ADR 0023, 0025). */
describe('API v0 — erased accounts everywhere', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  async function erase(accountId: string, type: AccountType) {
    const deletion = h.moduleRef.get(AccountDeletionService);
    const request = await w.helpers.as(w.a, { id: accountId, type }, () =>
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
  }

  it('in account and resident lists and details, the worker review, and the platform', async () => {
    const unit = await w.helpers.unit(w.a);
    const resident = await w.helpers.resident(w.a, [unit.id]);
    const residentToken = await w.tokenFor(w.a, resident.id, 'resident');
    const registered = await call(w, 'POST', `/units/${unit.id}/workers`, {
      token: residentToken,
      body: workerBody(),
    }).expect(201);
    const engagementId = (registered.body as { engagementId: string })
      .engagementId;
    const manager = await call(
      w,
      'POST',
      `/platform/tenants/${w.a.tenantId}/managers`,
      {
        token: w.platform.token,
        body: newManagerBody(),
      },
    ).expect(201);
    const managerId = (manager.body as { id: string }).id;

    await erase(resident.id, 'resident');
    await erase(managerId, 'manager');

    const token = w.a.tokens.manager;
    const tombstone = (id: string) => ({ id, erased: true });
    const inList = async (path: string, id: string) => {
      const res = await call(w, 'GET', path, {
        token,
        query: { limit: '100' },
      }).expect(200);
      return (res.body as { data: { id: string }[] }).data.find(
        (x) => x.id === id,
      );
    };

    expect(await inList('/accounts', resident.id)).toEqual(
      tombstone(resident.id),
    );
    expect(await inList('/accounts', managerId)).toEqual(tombstone(managerId));
    expect(await inList('/residents', resident.id)).toEqual(
      tombstone(resident.id),
    );
    for (const path of [
      `/accounts/${resident.id}`,
      `/residents/${resident.id}`,
      `/accounts/${managerId}`,
    ]) {
      const res = await call(w, 'GET', path, { token }).expect(200);
      expect(res.body).toEqual(tombstone(path.split('/').pop()!));
    }

    const detail = await call(w, 'GET', `/worker-engagements/${engagementId}`, {
      token,
    }).expect(200);
    expect((detail.body as { requestedBy: object }).requestedBy).toEqual(
      tombstone(resident.id),
    );

    const tenant = await call(w, 'GET', `/platform/tenants/${w.a.tenantId}`, {
      token: w.platform.token,
    }).expect(200);
    expect(
      (tenant.body as { managers: { id: string }[] }).managers.find(
        (m) => m.id === managerId,
      ),
    ).toEqual(tombstone(managerId));
  });
});
