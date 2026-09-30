import {
  AccountDeletionService,
  ERASURE_OVERDUE_SWEEP,
  scopePhrase,
} from '../../src/core/accounts/account-deletion.service';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import { RolesService } from '../../src/core/access/roles.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { SweepRunner } from '../../src/core/sweep/sweep-runner';
import { WorkersService } from '../../src/community/workers/workers.service';
import { auditReaders } from '../setup/audit';
import { communityHelpers, type Compound } from '../setup/community';
import { bornYearsAgo, codeOf, nationalIdFor } from '../setup/fixtures';
import {
  createHttpHarness,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { loginViaOtp } from '../setup/login';
import { required } from '../setup/test-env';
import { Client } from 'pg';

const HOLD = { code: 'litigation', text: 'Case 12/2026 — keep everything' };

/** Account deletion: grace, legal hold, erasure (ADR 0023; 02 §4, 09 §4–5). */
describe('Account erasure', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let deletion: AccountDeletionService;
  let globalDb: GlobalDbService;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    deletion = h.moduleRef.get(AccountDeletionService);
    globalDb = h.moduleRef.get(GlobalDbService);
  });

  afterAll(() => h.close());

  const asResident = <T>(c: Compound, id: string, fn: () => Promise<T>) =>
    x.as(c, { id, type: 'resident' }, fn);
  const asFamily = <T>(c: Compound, id: string, fn: () => Promise<T>) =>
    x.as(c, { id, type: 'family' }, fn);

  /** Time passes: the grace period is over (a test-only shortcut). */
  const pastGrace = (c: Compound, requestId: string, daysAgo = 1) =>
    x.asManager(c, () =>
      x.prisma.tenant.accountDeletionRequest.update({
        where: { id: requestId },
        data: {
          requestedAt: new Date(Date.now() - (daysAgo + 30) * 86_400_000),
          effectiveAt: new Date(Date.now() - daysAgo * 86_400_000),
        },
      }),
    );

  async function household() {
    const c = await x.compound('Erasure Court');
    const u = await x.unit(c);
    const primary = await x.resident(c, [u.id]);
    const family = await x.joinFamily(c, u.id, primary);
    return { c, unitId: u.id, primary, family };
  }

  it('the holder asks with the confirmation word, and can undo only within the grace period', async () => {
    const { c, primary } = await household();
    expect(
      await codeOf(
        asResident(c, primary.id, () => deletion.requestDeletion('yes')),
      ),
    ).toBe('CONFIRMATION_MISMATCH');
    const req = await asResident(c, primary.id, () =>
      deletion.requestDeletion('حذف'),
    );
    expect(req.effectiveAt.getTime() - req.requestedAt.getTime()).toBe(
      30 * 86_400_000,
    );
    expect(
      await codeOf(
        asResident(c, primary.id, () => deletion.requestDeletion('delete')),
      ),
    ).toBe('DELETION_ALREADY_REQUESTED');
    const [mail] = await globalDb.outboxMessage.findMany({
      where: {
        tenantId: c.tenantId,
        templateKey: 'account.deletion_requested',
      },
    });
    expect(mail.params).toMatchObject({
      effectiveDate: req.effectiveAt.toISOString().slice(0, 10),
    });
    // The account stays usable during the grace period.
    await loginViaOtp(h, primary.email, primary.id);
    await asResident(c, primary.id, () => deletion.cancelDeletion());
    expect(
      await asResident(c, primary.id, () => deletion.myDeletionRequest()),
    ).toMatchObject({
      status: 'cancelled',
    });

    const again = await asResident(c, primary.id, () =>
      deletion.requestDeletion('DELETE'),
    );
    await pastGrace(c, again.id);
    expect(
      await codeOf(asResident(c, primary.id, () => deletion.cancelDeletion())),
    ).toBe('DELETION_GRACE_OVER');
  });

  it('three steps: scope, legal hold, typed scope — each refusal holds', async () => {
    const { c, family } = await household();
    const req = await asFamily(c, family.accountId, () =>
      deletion.requestDeletion('DELETE'),
    );
    expect(
      await codeOf(
        x.asManager(c, () =>
          deletion.erase(req.id, scopePhrase(family.accountId)),
        ),
      ),
    ).toBe('DELETION_GRACE_NOT_OVER');
    await pastGrace(c, req.id);

    const scope = await x.asManager(c, () => deletion.erasureScope(req.id));
    expect(scope).toMatchObject({
      accountId: family.accountId,
      scopePhrase: scopePhrase(family.accountId),
      erased: { activeMemberships: 1, invitesAccepted: 1 },
    });
    expect(scope.kept.auditEntries).toBeGreaterThan(0);

    const holdId = await x.asManager(c, () =>
      deletion.placeLegalHold(family.accountId, HOLD),
    );
    expect(
      await x.asManager(c, () => deletion.activeHolds(family.accountId)),
    ).toHaveLength(1);
    expect(
      (await x.asManager(c, () => deletion.pendingErasures())).find(
        (p) => p.id === req.id,
      ),
    ).toMatchObject({ onLegalHold: true, daysOverdue: 1 });
    expect(
      await codeOf(
        x.asManager(c, () => deletion.erase(req.id, scope.scopePhrase)),
      ),
    ).toBe('LEGAL_HOLD_ACTIVE');
    // The person learns it is on hold, never why.
    const [held] = await globalDb.outboxMessage.findMany({
      where: { tenantId: c.tenantId, templateKey: 'account.legal_hold_placed' },
    });
    expect(held.recipientAccountId).toBe(family.accountId);
    expect(JSON.stringify(held.params)).not.toContain('Case 12');

    await x.asManager(c, () =>
      deletion.releaseLegalHold(holdId, {
        code: 'resolved',
        text: 'Case closed',
      }),
    );
    expect(
      await codeOf(
        x.asManager(c, () => deletion.erase(req.id, 'ERASE something')),
      ),
    ).toBe('SCOPE_CONFIRMATION_MISMATCH');
    await x.asManager(c, () => deletion.erase(req.id, scope.scopePhrase));
  });

  it('erasing a member: a tombstone; login, sessions and pending mail gone; the invite stripped; the audit untouched', async () => {
    const { c, unitId, family } = await household();
    await loginViaOtp(h, family.email, family.accountId);
    const req = await asFamily(c, family.accountId, () =>
      deletion.requestDeletion('DELETE'),
    );
    await pastGrace(c, req.id);
    const read = auditReaders(h);
    const before = await read.tenant(c.tenantId);

    await x.asManager(c, () =>
      deletion.erase(req.id, scopePhrase(family.accountId)),
    );

    const account = await x.asManager(c, () =>
      x.prisma.tenant.account.findUniqueOrThrow({
        where: { id: family.accountId },
      }),
    );
    expect(account).toMatchObject({
      status: 'erased',
      fullName: null,
      phone: null,
      email: null,
      idDocumentType: null,
      idDocumentNumber: null,
      nationality: null,
      birthDate: null,
    });
    // A join shows a deleted user.
    expect(
      await x.asManager(c, () =>
        h.moduleRef.get(AccountsService).get(family.accountId),
      ),
    ).toMatchObject({
      status: 'erased',
      fullName: null,
    });
    expect(
      await globalDb.loginIdentifier.count({
        where: { accountId: family.accountId },
      }),
    ).toBe(0);
    expect(
      await globalDb.session.count({ where: { accountId: family.accountId } }),
    ).toBe(0);
    // Mail that was waiting for them is stripped; the last word is queued.
    const mails = await globalDb.outboxMessage.findMany({
      where: { tenantId: c.tenantId },
    });
    const theirs = mails.filter(
      (m) => m.recipientAccountId === family.accountId,
    );
    expect(theirs.length).toBeGreaterThan(0);
    for (const m of theirs) {
      expect(m).toMatchObject({
        status: 'dead',
        recipient: null,
        params: null,
      });
    }
    expect(mails.find((m) => m.templateKey === 'account.erased')).toMatchObject(
      {
        status: 'pending',
        recipient: family.email,
      },
    );
    // The invite that brought them in.
    const [invite] = await x.asManager(c, () =>
      x.prisma.tenant.householdInvite.findMany({
        where: { acceptedAccountId: family.accountId },
      }),
    );
    expect(invite).toMatchObject({
      fullName: null,
      email: null,
      phone: null,
      idDocumentNumber: null,
    });
    expect(invite.strippedAt).toBeInstanceOf(Date);
    // The membership ended.
    expect(
      await x.asManager(c, () =>
        x.prisma.tenant.householdMember.findFirstOrThrow({
          where: { unitId, accountId: family.accountId },
        }),
      ),
    ).toMatchObject({ status: 'removed' });

    // The audit log only grew; no earlier row changed, none holds their data.
    const after = await read.tenant(c.tenantId);
    expect(after.slice(0, before.length)).toEqual(before);
    const [erased] = await read.tenant(c.tenantId, {
      action: 'account.erased',
      targetId: family.accountId,
    });
    expect(erased.changes).toMatchObject({
      status: { from: 'active', to: 'erased' },
      fullName: { changed: true },
      email: { changed: true },
    });
    const text = JSON.stringify(after);
    for (const value of [
      family.email,
      family.phone,
      family.fullName,
      family.idDocumentNumber,
    ]) {
      expect(text).not.toContain(value);
    }
  });

  it('erasing a primary: the unit goes under review (no hand-over first), and their workers end with a notice and a wage obligation', async () => {
    const { c, unitId, primary } = await household();
    const workers = h.moduleRef.get(WorkersService);
    const reg = await asResident(c, primary.id, () =>
      workers.register(unitId, {
        fullName: 'Worker Erasure',
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(bornYearsAgo(30)),
        phone: uniquePhone(),
        capacity: 'live_in',
      }),
    );
    await x.asManager(c, () => workers.review(reg.engagementId, 'approve'));
    const req = await asResident(c, primary.id, () =>
      deletion.requestDeletion('DELETE'),
    );
    await pastGrace(c, req.id);
    await x.asManager(c, () => deletion.erase(req.id, scopePhrase(primary.id)));

    const [occupancy] = await x.occupancies(c, unitId);
    expect(occupancy).toMatchObject({
      status: 'ended',
      endReason: 'account_erased',
    });
    expect(await x.openReviews(c, unitId)).toEqual(['primary_left']);
    const [engagement, notices, obligations] = await x.asManager(c, () =>
      Promise.all([
        x.prisma.tenant.workerEngagement.findUniqueOrThrow({
          where: { id: reg.engagementId },
        }),
        x.prisma.tenant.workerNotice.findMany({
          where: { engagementId: reg.engagementId },
        }),
        x.prisma.tenant.workerWageObligation.findMany({
          where: { engagementId: reg.engagementId },
        }),
      ]),
    );
    expect(engagement).toMatchObject({
      status: 'ended',
      statusReason: 'requester_erased',
    });
    expect(notices.map((n) => n.noticeKey)).toContain('engagement_ended');
    expect(obligations.map((o) => o.kind)).toEqual(['settle_before_close']);
  });

  it('a hold and an erasure never cross: exactly one wins', async () => {
    const { c, family } = await household();
    const req = await asFamily(c, family.accountId, () =>
      deletion.requestDeletion('DELETE'),
    );
    await pastGrace(c, req.id);
    const results = await Promise.allSettled([
      x.asManager(c, () => deletion.placeLegalHold(family.accountId, HOLD)),
      x.asManager(c, () =>
        deletion.erase(req.id, scopePhrase(family.accountId)),
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('an overdue erasure is reported once to the erasure holders — or on file when nobody holds it', async () => {
    const { c, primary } = await household();
    const req = await asResident(c, primary.id, () =>
      deletion.requestDeletion('DELETE'),
    );
    await pastGrace(c, req.id, 8);
    const sweep = h.moduleRef.get(SweepRunner);
    expect(await sweep.run(ERASURE_OVERDUE_SWEEP)).toBeGreaterThanOrEqual(1);
    const [told] = await globalDb.outboxMessage.findMany({
      where: { tenantId: c.tenantId, templateKey: 'account.erasure_overdue' },
    });
    expect(told).toMatchObject({
      recipientAccountId: c.managerId,
      params: expect.objectContaining({
        requestId: req.id,
        days: '8',
      }) as object,
    });
    const [entry] = await auditReaders(h).tenant(c.tenantId, {
      action: 'account.erasure_overdue',
      targetId: req.id,
    });
    expect(entry).toMatchObject({
      actorType: 'system',
      metadata: { daysOverdue: 8, holdersTold: 1 },
    });
    await sweep.run(ERASURE_OVERDUE_SWEEP);
    expect(
      await globalDb.outboxMessage.count({
        where: { tenantId: c.tenantId, templateKey: 'account.erasure_overdue' },
      }),
    ).toBe(1);

    // Nobody holds accounts.erase: the notice is recorded as undeliverable.
    const other = await household();
    const roles = h.moduleRef.get(RolesService);
    await x.asManager(other.c, async () => {
      const manager = (await roles.list()).find((r) => r.key === 'manager')!;
      await roles.replacePermissions(
        manager.id,
        manager.permissions.filter((p) => p !== 'accounts.erase'),
      );
    });
    const req2 = await asResident(other.c, other.primary.id, () =>
      deletion.requestDeletion('DELETE'),
    );
    await pastGrace(other.c, req2.id, 9);
    await sweep.run(ERASURE_OVERDUE_SWEEP);
    const [dead] = await globalDb.outboxMessage.findMany({
      where: {
        tenantId: other.c.tenantId,
        templateKey: 'account.erasure_overdue',
      },
    });
    expect(dead).toMatchObject({
      status: 'dead',
      lastErrorCode: 'NO_RECIPIENT',
    });
  });

  it('the database holds the tombstone shape: all personal fields NULL, or none (a frozen account may lack only its phone)', async () => {
    const { c, primary } = await household();
    const db = new Client({
      connectionString: required('TEST_MIGRATOR_DATABASE_URL'),
    });
    await db.connect();
    const attempt = async (sql: string) => {
      await db.query('BEGIN');
      await db.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        c.tenantId,
      ]);
      try {
        await db.query(sql, [primary.id]);
        return 'ok';
      } catch (error) {
        return (error as { constraint?: string }).constraint ?? 'error';
      } finally {
        await db.query('ROLLBACK');
      }
    };
    try {
      expect(
        await attempt(`UPDATE accounts SET full_name = NULL WHERE id = $1`),
      ).toBe('accounts_erased_shape');
      expect(
        await attempt(`UPDATE accounts SET phone = NULL WHERE id = $1`),
      ).toBe('accounts_erased_shape');
      expect(
        await attempt(`UPDATE accounts SET status = 'erased' WHERE id = $1`),
      ).toBe('accounts_erased_shape');
      expect(
        await attempt(
          `UPDATE accounts SET status = 'frozen', phone = NULL WHERE id = $1`,
        ),
      ).toBe('ok');
      expect(
        await attempt(
          `UPDATE accounts SET status = 'erased', full_name = NULL, phone = NULL,
             email = NULL, id_document_type = NULL, id_document_number = NULL,
             nationality = NULL, birth_date = NULL WHERE id = $1`,
        ),
      ).toBe('ok');
    } finally {
      await db.end();
    }
  });

  it("tenant B can't see, hold or erase A's accounts", async () => {
    const a = await household();
    const b = await x.compound();
    const req = await asResident(a.c, a.primary.id, () =>
      deletion.requestDeletion('DELETE'),
    );
    await pastGrace(a.c, req.id);
    expect(await x.asManager(b, () => deletion.pendingErasures())).toEqual([]);
    expect(
      await codeOf(x.asManager(b, () => deletion.erasureScope(req.id))),
    ).toBe('DELETION_REQUEST_NOT_FOUND');
    expect(
      await codeOf(
        x.asManager(b, () => deletion.erase(req.id, scopePhrase(a.primary.id))),
      ),
    ).toBe('DELETION_REQUEST_NOT_FOUND');
    expect(
      await codeOf(
        x.asManager(b, () => deletion.placeLegalHold(a.primary.id, HOLD)),
      ),
    ).toBe('ACCOUNT_NOT_FOUND');
  });
});
