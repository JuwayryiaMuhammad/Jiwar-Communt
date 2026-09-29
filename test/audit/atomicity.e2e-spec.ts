import { ClsService } from 'nestjs-cls';
import { AuditService } from '../../src/core/audit/audit.service';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { newId } from '../../src/core/common/uuid';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { TenantsService } from '../../src/core/platform/tenants.service';
import { auditReaders } from '../setup/audit';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';

/** ADR 0014: an entry commits with its action, or neither does. */
describe('Audit atomicity', () => {
  let h: HttpHarness;
  let read: ReturnType<typeof auditReaders>;
  let audit: AuditService;
  let tenantTx: TenantTx;
  let cls: ClsService<AppClsStore>;
  let c: { tenantId: string; managerId: string; token: string };

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    read = auditReaders(h);
    audit = h.moduleRef.get(AuditService);
    tenantTx = h.moduleRef.get(TenantTx);
    cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
    const created = await h.moduleRef.get(TenantsService).createTenant({
      name: 'Atomic Court',
      manager: {
        fullName: 'Manager',
        nationalId: '29001019990001',
        phone: uniquePhone(),
        email: uniqueEmail('mgr'),
      },
    });
    const managerId = created.managers[0].id;
    c = {
      tenantId: created.id,
      managerId,
      token: await h.tokenFor({
        sub: managerId,
        tid: created.id,
        typ: 'manager',
      }),
    };
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(() => h.close());

  const inTenant = <T>(fn: () => Promise<T>) =>
    cls.run(async () => {
      cls.set('tenantId', c.tenantId);
      cls.set('accountId', c.managerId);
      return await fn();
    });

  const unitCodes = async () => {
    const res = await h
      .http()
      .get(`${API}/units`)
      .set('Authorization', `Bearer ${c.token}`)
      .expect(200);
    return (res.body as { code: string }[]).map((u) => u.code);
  };

  it('an action that fails after record() leaves no entry', async () => {
    const targetId = newId();
    await expect(
      inTenant(() =>
        tenantTx.withTenantTx(async (tx) => {
          await audit.record(tx, { action: 'unit.created', targetId });
          throw new Error('the action failed after auditing');
        }),
      ),
    ).rejects.toThrow('the action failed after auditing');
    expect(await read.tenant(c.tenantId, { targetId })).toEqual([]);
  });

  it('a failing record() rolls the action back', async () => {
    jest
      .spyOn(audit, 'record')
      .mockRejectedValueOnce(new Error('audit write failed'));
    const res = await h
      .http()
      .post(`${API}/units`)
      .set('Authorization', `Bearer ${c.token}`)
      .send({ code: 'ROLLED-BACK' })
      .expect(500);
    expect(res.body).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(await unitCodes()).not.toContain('ROLLED-BACK');
  });

  it('a sensitive metadata key throws before any insert and rolls the action back', async () => {
    const code = `S-${newId().slice(-6)}`;
    await expect(
      inTenant(() =>
        tenantTx.withTenantTx(async (tx) => {
          const unit = await tx.unit.create({
            data: { id: newId(), tenantId: c.tenantId, code },
          });
          await audit.record(tx, {
            action: 'unit.created',
            targetId: unit.id,
            metadata: { notify: { email: 'someone@example.com' } },
          });
        }),
      ),
    ).rejects.toThrow(/Sensitive key "metadata.notify.email"/);
    expect(await unitCodes()).not.toContain(code);
  });

  it('record() refuses a transaction that did not come from TenantTx', async () => {
    const globalDb = h.moduleRef.get(
      (await import('../../src/core/database/global-db.service'))
        .GlobalDbService,
    );
    await expect(
      globalDb.transaction((tx) =>
        audit.record(tx, { action: 'unit.created', targetId: newId() }),
      ),
    ).rejects.toThrow(/inside a TenantTx transaction/);
  });

  describe('personal-looking values', () => {
    it('in production mode: redacted, and the action succeeds', async () => {
      jest.replaceProperty(
        audit as unknown as { strict: boolean },
        'strict',
        false,
      );
      const res = await h
        .http()
        .post(`${API}/units`)
        .set('Authorization', `Bearer ${c.token}`)
        .send({ code: '01012345678' })
        .expect(201);
      const row = (
        await read.tenant(c.tenantId, {
          targetId: (res.body as { id: string }).id,
        })
      )[0];
      expect(row.changes).toMatchObject({
        code: { from: null, to: '[redacted]' },
      });
      expect(JSON.stringify(row.changes)).not.toContain('01012345678');
    });

    it('in tests: the same value throws, so real leaks surface early', async () => {
      await h
        .http()
        .post(`${API}/units`)
        .set('Authorization', `Bearer ${c.token}`)
        .send({ code: '01099999999' })
        .expect(500);
      expect(await unitCodes()).not.toContain('01099999999');
    });
  });
});
