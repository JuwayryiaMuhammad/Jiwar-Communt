import { RolesService } from '../../src/core/access/roles.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { auditReaders } from '../setup/audit';
import { communityHelpers, type Compound } from '../setup/community';
import { buildExports } from '../setup/exports';
import { gateHelpers } from '../setup/gate';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import { waitForMessage, waitForOtp } from '../setup/mailpit';
import { drainOutbox } from '../setup/outbox';

/**
 * The assisted path (ADR 0036, `residents.assist`): a manager acts for an
 * account that does not use the app. Every action needs a reason code, is
 * marked assisted in its events and audit, and tells the account. An
 * assisted export reaches only the account's own email, behind a code sent
 * there too, at most three times; the manager never gets a link.
 */
describe('Assisted path', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let c: Compound;
  let managerToken: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    x = communityHelpers(h);
    c = await x.compound('Assist Court');
    managerToken = await h.tokenFor({
      sub: c.managerId,
      tid: c.tenantId,
      typ: 'manager',
    });
  });

  afterAll(() => h.close());

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const post = (path: string, body: object, token = managerToken) =>
    h.http().post(`${API}${path}`).set(bearer(token)).send(body);

  /** A tenant beside the owner (a primary may not be deleted). */
  async function someone() {
    const unit = await x.unit(c);
    await x.resident(c, [unit.id]);
    return x.resident(c, [unit.id], 'tenant');
  }
  const told = (accountId: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.notification.findMany({
        where: { accountId, kind: 'account.assisted_action' },
        orderBy: { createdAt: 'asc' },
      }),
    );

  it('needs a reason code from the closed list', async () => {
    const p = await someone();
    const none = await post(`/accounts/${p.id}/data-exports`, {}).expect(400);
    expect(none.body).toMatchObject({
      code: 'REASON_REQUIRED',
      fields: [{ field: 'reasonCode', code: 'FIELD_REQUIRED' }],
    });
    const unknown = await post(`/accounts/${p.id}/deletion-request`, {
      reasonCode: 'email',
    }).expect(400);
    expect(unknown.body).toMatchObject({
      fields: [
        {
          field: 'reasonCode',
          code: 'INVALID_REASON_CODE',
          params: { allowed: ['in_person', 'phone_call', 'written_request'] },
        },
      ],
    });
  });

  it('needs residents.assist: a manager whose role lost it is refused', async () => {
    const other = await x.compound('Assist No Permission');
    const roles = h.moduleRef.get(RolesService);
    await x.asManager(other, async () => {
      const manager = (await roles.list()).find((r) => r.key === 'manager')!;
      await roles.replacePermissions(
        manager.id,
        manager.permissions.filter((p) => p !== 'residents.assist'),
      );
    });
    const unit = await x.unit(other);
    const p = await x.resident(other, [unit.id]);
    const token = await h.tokenFor({
      sub: other.managerId,
      tid: other.tenantId,
      typ: 'manager',
    });
    const res = await h
      .http()
      .get(`${API}/accounts/${p.id}/consents`)
      .set(bearer(token))
      .expect(403);
    expect((res.body as { code: string }).code).toBe('FORBIDDEN');
  });

  it('acts only for a resident or family account', async () => {
    const guard = await gateHelpers(h).guard(c);
    for (const id of [guard.id, c.managerId]) {
      const res = await post(`/accounts/${id}/consents/grant`, {
        code: 'ticket_phone_share',
        version: 1,
        reasonCode: 'in_person',
      }).expect(404);
      expect((res.body as { code: string }).code).toBe('ACCOUNT_NOT_FOUND');
    }
  });

  it('preferences and consents: marked assisted, audited with the reason, the account told', async () => {
    const p = await someone();
    const prefs = await h
      .http()
      .patch(`${API}/accounts/${p.id}/notification-preferences`)
      .set(bearer(managerToken))
      .send({
        categories: [{ category: 'household', email: false }],
        reasonCode: 'phone_call',
      })
      .expect(200);
    expect(
      (
        prefs.body as { categories: { category: string; email: boolean }[] }
      ).categories.find((x) => x.category === 'household')!.email,
    ).toBe(false);
    await post(`/accounts/${p.id}/consents/grant`, {
      code: 'ticket_phone_share',
      version: 1,
      reasonCode: 'written_request',
    }).expect(200);
    await post(`/accounts/${p.id}/consents/revoke`, {
      code: 'ticket_phone_share',
      reasonCode: 'in_person',
    }).expect(200);

    const events = await x.asManager(c, () =>
      x.prisma.tenant.consentEvent.findMany({
        where: { accountId: p.id },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(
      events.map((e) => [
        e.action,
        e.assisted,
        e.assistReasonCode,
        e.actorAccountId,
      ]),
    ).toEqual([
      ['grant', true, 'written_request', c.managerId],
      ['revoke', true, 'in_person', c.managerId],
    ]);
    const read = auditReaders(h);
    const [changed] = await read.tenant(c.tenantId, {
      action: 'notification_preferences.changed',
      targetId: p.id,
    });
    expect(changed).toMatchObject({
      actorId: c.managerId,
      metadata: { assisted: true, reasonCode: 'phone_call' },
    });
    const [granted] = await read.tenant(c.tenantId, {
      action: 'consent.granted',
      targetId: p.id,
    });
    expect(granted.metadata).toEqual({
      code: 'ticket_phone_share',
      version: 1,
      assisted: true,
      reasonCode: 'written_request',
    });
    expect((await told(p.id)).map((n) => n.params)).toEqual([
      { action: 'notification_preferences', reason: 'phone_call' },
      { action: 'consent_granted', reason: 'written_request' },
      { action: 'consent_revoked', reason: 'in_person' },
    ]);
    const mails = await h.moduleRef.get(GlobalDbService).outboxMessage.count({
      where: {
        recipientAccountId: p.id,
        templateKey: 'account.assisted_action',
      },
    });
    expect(mails).toBe(3);
  });

  it('a deletion request, and its undo, for the account', async () => {
    const p = await someone();
    const res = await post(`/accounts/${p.id}/deletion-request`, {
      reasonCode: 'written_request',
    }).expect(201);
    expect(res.body).toMatchObject({ status: 'pending', assisted: true });
    const [row] = await x.asManager(c, () =>
      x.prisma.tenant.accountDeletionRequest.findMany({
        where: { accountId: p.id },
      }),
    );
    expect(row).toMatchObject({
      assisted: true,
      assistReasonCode: 'written_request',
      requestedById: c.managerId,
    });
    await post(`/accounts/${p.id}/deletion-request/cancel`, {
      reasonCode: 'phone_call',
    }).expect(204);
    const [cancelled] = await auditReaders(h).tenant(c.tenantId, {
      action: 'account.deletion_cancelled',
      targetId: p.id,
    });
    expect(cancelled.metadata).toMatchObject({
      assisted: true,
      reasonCode: 'phone_call',
    });
    // A primary is refused for the same reason as on their own.
    const unit = await x.unit(c);
    const owner = await x.resident(c, [unit.id]);
    const blocked = await post(`/accounts/${owner.id}/deletion-request`, {
      reasonCode: 'in_person',
    }).expect(409);
    expect(blocked.body).toMatchObject({
      code: 'DELETION_BLOCKED',
      params: { blockers: ['primary_resident'] },
    });
  });

  it('an export goes only to the account’s email: link, a code, three downloads', async () => {
    const p = await someone();
    const filed = await post(`/accounts/${p.id}/data-exports`, {
      reasonCode: 'in_person',
    }).expect(201);
    const body = filed.body as { id: string; assisted: boolean };
    expect(body.assisted).toBe(true);
    expect(JSON.stringify(filed.body)).not.toMatch(/https?:|X-Amz/);
    const since = new Date();
    await buildExports(h);
    await drainOutbox(h);
    const mail = await waitForMessage(p.email, since);
    const token = /\/a\/export#([0-9a-f-]{36}\.[0-9a-f]{64})/.exec(
      mail.Text,
    )![1];

    // The manager cannot download it, in the app or anywhere.
    await h
      .http()
      .get(`${API}/me/data-exports/${body.id}/download`)
      .set(bearer(managerToken))
      .expect(404);

    // The link alone downloads nothing: a code first, sent to the account.
    const noCode = await h
      .http()
      .post(`${API}/public/data-exports/download`)
      .send({ token, code: '000000' })
      .expect(403);
    expect((noCode.body as { code: string }).code).toBe('STEP_UP_CODE_INVALID');
    const download = async () => {
      const at = new Date();
      await h
        .http()
        .post(`${API}/public/data-exports/code`)
        .send({ token })
        .expect(202);
      const code = await waitForOtp(p.email, at);
      return h
        .http()
        .post(`${API}/public/data-exports/download`)
        .send({ token, code });
    };
    for (let i = 0; i < 3; i++) {
      const res = await download();
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect((res.body as { url: string }).url).toMatch(/^https?:/);
    }
    // The fourth: the link has stopped working.
    const spent = await h
      .http()
      .post(`${API}/public/data-exports/code`)
      .send({ token })
      .expect(404);
    expect((spent.body as { code: string }).code).toBe('ACTION_TOKEN_INVALID');

    const uses = await auditReaders(h).tenant(c.tenantId, {
      action: 'data_export.downloaded',
      targetId: body.id,
    });
    expect(uses.map((u) => u.metadata)).toEqual([
      { via: 'email_link', use: 1 },
      { via: 'email_link', use: 2 },
      { via: 'email_link', use: 3 },
    ]);
    expect(
      (await told(p.id)).map((n) => (n.params as { action: string }).action),
    ).toEqual(['data_export']);
  });
});
