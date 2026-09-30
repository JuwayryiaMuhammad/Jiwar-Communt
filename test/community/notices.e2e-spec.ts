import { StaffRecipients } from '../../src/core/access/staff-recipients';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { NO_RECIPIENT } from '../../src/core/mail/outbox';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { HouseholdsService } from '../../src/community/households/households.service';
import { auditReaders } from '../setup/audit';
import { communityHelpers } from '../setup/community';
import { bornYearsAgo, nationalIdFor } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * "Never silent" (Phase 2.2): a notice with nobody to go to is on file as
 * undeliverable, and messages carry the account they are for.
 */
describe('Notices', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let globalDb: GlobalDbService;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    globalDb = h.moduleRef.get(GlobalDbService);
  });

  afterAll(() => h.close());

  it('removing a minor records an undeliverable notice with nothing personal in it', async () => {
    const c = await x.compound();
    const u = await x.unit(c);
    const primary = await x.resident(c, [u.id]);
    const households = h.moduleRef.get(HouseholdsService);
    const asPrimary = <T>(fn: () => Promise<T>) =>
      x.as(c, { id: primary.id, type: 'resident' }, fn);
    const kid = await asPrimary(() =>
      households.addMinor(u.id, {
        fullName: 'Kid Undeliverable',
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(bornYearsAgo(9)),
        relation: 'child',
      }),
    );
    await asPrimary(() =>
      households.removeMember(kid.id, { code: 'other', text: 'moved away' }),
    );

    const rows = await globalDb.outboxMessage.findMany({
      where: { tenantId: c.tenantId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      templateKey: 'household.member_removed',
      status: 'dead',
      lastErrorCode: NO_RECIPIENT,
      recipient: null,
      params: null,
      attempts: 0,
    });
    expect(rows[0].strippedAt).toBeInstanceOf(Date);
    const [entry] = await auditReaders(h).tenant(c.tenantId, {
      action: 'household.member_removed',
      targetId: kid.id,
    });
    expect(entry.metadata).toMatchObject({ noticeUndeliverable: true });
  });

  it('a removal email carries the account it is for', async () => {
    const c = await x.compound();
    const u = await x.unit(c);
    const primary = await x.resident(c, [u.id]);
    const joined = await x.joinFamily(c, u.id, primary);
    await x.as(c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef
        .get(HouseholdsService)
        .removeMember(joined.memberId, { code: 'other', text: 'left' }),
    );
    const [message] = await globalDb.outboxMessage.findMany({
      where: { tenantId: c.tenantId, templateKey: 'household.member_removed' },
    });
    expect(message).toMatchObject({
      status: 'pending',
      recipient: joined.email,
      recipientAccountId: joined.accountId,
    });
  });

  it('staff recipients: active holders of the permission, in this compound only', async () => {
    const a = await x.compound();
    const b = await x.compound();
    const staff = h.moduleRef.get(StaffRecipients);
    const tenantTx = h.moduleRef.get(TenantTx);
    const holders = (c: typeof a) =>
      x.asManager(c, () =>
        tenantTx.withTenantTx((tx) => staff.holding(tx, 'workers.ban')),
      );
    expect((await holders(a)).map((r) => r.id)).toEqual([a.managerId]);
    expect((await holders(b)).map((r) => r.id)).toEqual([b.managerId]);
    // Residents never hold a manager permission.
    const u = await x.unit(a);
    await x.resident(a, [u.id]);
    expect(await holders(a)).toHaveLength(1);
  });

  it('the retrofitted actions record the reason code, never the text', async () => {
    const c = await x.compound();
    const u = await x.unit(c);
    const primary = await x.resident(c, [u.id]);
    const joined = await x.joinFamily(c, u.id, primary);
    await x.as(c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef.get(HouseholdsService).removeMember(joined.memberId, {
        code: 'relation_ended',
        text: 'Divorced from Hassan',
      }),
    );
    const [entry] = await auditReaders(h).tenant(c.tenantId, {
      action: 'household.member_removed',
      targetId: joined.memberId,
    });
    expect(entry.metadata).toMatchObject({ reasonCode: 'relation_ended' });
    expect(JSON.stringify(entry)).not.toContain('Hassan');
    expect(
      await x
        .as(c, { id: primary.id, type: 'resident' }, () =>
          h.moduleRef.get(HouseholdsService).removeMember(joined.memberId, {
            code: 'because',
            text: 'x',
          }),
        )
        .catch((e: { response: { code: string } }) => e.response.code),
    ).toBe('VALIDATION_FAILED');
  });
});
