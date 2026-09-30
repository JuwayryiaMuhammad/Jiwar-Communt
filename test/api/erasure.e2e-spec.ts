import { AccountDeletionService } from '../../src/core/accounts/account-deletion.service';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { keyPaths, listKeys } from './keys';
import { call, err } from './request';
import { buildWorld, type World } from './world';

describe('API v0 — erasure', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  const manager = () => w.a.tokens.manager;

  it('three steps with a legal hold in between, then the tombstone everywhere', async () => {
    const leaving = await w.helpers.resident(w.a, [w.a.rentedUnitId], 'tenant');
    const request = await w.helpers.as(
      w.a,
      { id: leaving.id, type: 'resident' },
      () => h.moduleRef.get(AccountDeletionService).requestDeletion('DELETE'),
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

    const list = await call(w, 'GET', '/erasures', { token: manager() }).expect(
      200,
    );
    expect(keyPaths(list.body)).toEqual(
      listKeys([
        'accountId',
        'daysOverdue',
        'effectiveAt',
        'id',
        'onLegalHold',
        'requestedAt',
        'status',
      ]),
    );

    const scope = await call(w, 'GET', `/erasures/${request.id}/scope`, {
      token: manager(),
    }).expect(200);
    expect(keyPaths(scope.body)).toEqual([
      'accountId',
      'erased',
      'erased.activeMemberships',
      'erased.activeOccupancies',
      'erased.invitesAccepted',
      'erased.pendingMessages',
      'erased.personalFields',
      'erased.sessions',
      'erased.workerEngagementsRequested',
      'kept',
      'kept.auditEntries',
      'requestId',
      'scopePhrase',
    ]);
    const { scopePhrase } = scope.body as { scopePhrase: string };

    const hold = await call(w, 'POST', `/accounts/${leaving.id}/legal-holds`, {
      token: manager(),
      body: { reasonCode: 'litigation', reason: 'A private court matter' },
    }).expect(201);
    expect(keyPaths(hold.body)).toEqual(['id']);
    const holds = await call(w, 'GET', `/accounts/${leaving.id}/legal-holds`, {
      token: manager(),
    }).expect(200);
    expect(keyPaths(holds.body)).toEqual(
      listKeys(['accountId', 'id', 'placedAt', 'reasonCode']),
    );
    expect(JSON.stringify(holds.body)).not.toContain('A private court matter');

    const held = await call(w, 'POST', `/erasures/${request.id}/erase`, {
      token: manager(),
      body: { typedScope: scopePhrase },
    });
    expect(err(held).code).toBe('LEGAL_HOLD_ACTIVE');
    await call(
      w,
      'POST',
      `/legal-holds/${(hold.body as { id: string }).id}/release`,
      {
        token: manager(),
        body: { reasonCode: 'resolved', reason: 'Settled' },
      },
    ).expect(204);

    const wrong = await call(w, 'POST', `/erasures/${request.id}/erase`, {
      token: manager(),
      body: { typedScope: 'erase everything' },
    });
    expect(err(wrong).code).toBe('SCOPE_CONFIRMATION_MISMATCH');
    await call(w, 'POST', `/erasures/${request.id}/erase`, {
      token: manager(),
      body: { typedScope: scopePhrase },
    }).expect(204);

    for (const path of [
      `/accounts/${leaving.id}`,
      `/residents/${leaving.id}`,
    ]) {
      const res = await call(w, 'GET', path, { token: manager() }).expect(200);
      expect(res.body).toEqual({ id: leaving.id, erased: true });
    }
  });
});
