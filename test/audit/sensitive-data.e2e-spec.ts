import { ClsService } from 'nestjs-cls';
import { looksPersonal } from '../../src/core/audit/personal-data';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { TenantsService } from '../../src/core/platform/tenants.service';
import { ResidentsService } from '../../src/community/residents/residents.service';
import { auditReaders } from '../setup/audit';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { loginViaOtp } from '../setup/login';
import { countEmails, waitForOtp } from '../setup/mailpit';

/** ADR 0014: no personal data by value in audit entries, ever. */
describe('Audit entries hold no personal data', () => {
  let h: HttpHarness;
  let read: ReturnType<typeof auditReaders>;
  let cls: ClsService<AppClsStore>;
  let tenants: TenantsService;
  let residents: ResidentsService;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    read = auditReaders(h);
    cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
    tenants = h.moduleRef.get(TenantsService);
    residents = h.moduleRef.get(ResidentsService);
  });

  afterAll(() => h.close());

  /** Every string anywhere in a JSON value. */
  function strings(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    if (value && typeof value === 'object')
      return Object.values(value).flatMap(strings);
    return [];
  }

  it('creating, and changing phone and email, leaves no value behind', async () => {
    const managerContact = { phone: uniquePhone(), email: uniqueEmail('mgr') };
    const created = await tenants.createTenant({
      name: 'Private Court',
      manager: {
        fullName: 'Mariam Manager',
        nationalId: '29001014445556',
        ...managerContact,
      },
    });
    const c = { tenantId: created.id, managerId: created.managers[0].id };
    const token = await h.tokenFor({
      sub: c.managerId,
      tid: c.tenantId,
      typ: 'manager',
    });
    const unit = await h
      .http()
      .post(`${API}/units`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'P-1' });

    const person = {
      fullName: 'Ahmed Mohamed Hassan',
      nationalId: '29001015556667',
      phone: uniquePhone(),
      email: uniqueEmail('ahmed'),
    };
    const next = { phone: uniquePhone(), email: uniqueEmail('ahmed-new') };
    const asManager = <T>(fn: () => Promise<T>) =>
      cls.run(async () => {
        cls.set('tenantId', c.tenantId);
        cls.set('accountId', c.managerId);
        cls.set('accountType', 'manager');
        return await fn();
      });

    const resident = await asManager(() =>
      residents.createResident({
        ...person,
        units: [
          { unitId: (unit.body as { id: string }).id, occupancyType: 'owner' },
        ],
      }),
    );
    await asManager(() => residents.updateContact(resident.id, next));

    const rows = [
      ...(await read.tenant(c.tenantId)),
      ...(await read.platform({ targetTenantId: c.tenantId })),
    ];
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'account.created',
        'account.contact_changed',
        'tenant.created',
      ]),
    );

    const stored = JSON.stringify(
      rows.map((r) => ({ changes: r.changes, metadata: r.metadata })),
    );
    const forbidden = [
      person.fullName,
      person.nationalId,
      person.phone,
      `0${person.phone.slice(3)}`, // local form
      person.email,
      next.phone,
      `0${next.phone.slice(3)}`,
      next.email,
      'Mariam Manager',
      '29001014445556',
      managerContact.phone,
      managerContact.email,
    ];
    for (const value of forbidden) expect(stored).not.toContain(value);

    // Second net: nothing in any stored JSON even looks personal.
    const suspicious = rows
      .flatMap((r) => strings([r.changes, r.metadata]))
      .filter((s) => looksPersonal(s));
    expect(suspicious).toEqual([]);
  });

  it('a contact change moves login to the new email and kills codes sent to the old one', async () => {
    const created = await tenants.createTenant({
      name: 'Contact Court',
      manager: {
        fullName: 'Manager',
        nationalId: '29001016667778',
        phone: uniquePhone(),
        email: uniqueEmail('mgr'),
      },
    });
    const c = { tenantId: created.id, managerId: created.managers[0].id };
    const token = await h.tokenFor({
      sub: c.managerId,
      tid: c.tenantId,
      typ: 'manager',
    });
    const unit = await h
      .http()
      .post(`${API}/units`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'K-1' });
    const oldEmail = uniqueEmail('before');
    const newEmail = uniqueEmail('after');
    const asManager = <T>(fn: () => Promise<T>) =>
      cls.run(async () => {
        cls.set('tenantId', c.tenantId);
        cls.set('accountId', c.managerId);
        cls.set('accountType', 'manager');
        return await fn();
      });
    const resident = await asManager(() =>
      residents.createResident({
        fullName: 'Moving Person',
        nationalId: '29001017778889',
        phone: uniquePhone(),
        email: oldEmail,
        units: [
          { unitId: (unit.body as { id: string }).id, occupancyType: 'owner' },
        ],
      }),
    );

    // A code is on its way to the old mailbox when the email changes.
    const since = new Date();
    await h
      .http()
      .post(`${API}/auth/otp/request`)
      .send({ identifier: oldEmail })
      .expect(202);
    const staleCode = await waitForOtp(oldEmail, since);

    await asManager(() =>
      residents.updateContact(resident.id, { email: newEmail }),
    );
    const row = (
      await read.tenant(c.tenantId, { action: 'account.contact_changed' })
    )[0];
    expect(row.metadata).toEqual({ codesInvalidated: 1 });

    await h
      .http()
      .post(`${API}/auth/otp/verify`)
      .send({ identifier: oldEmail, code: staleCode })
      .expect(401);

    const after = new Date();
    await h
      .http()
      .post(`${API}/auth/otp/request`)
      .send({ identifier: oldEmail })
      .expect(202);
    expect(await countEmails(oldEmail, after)).toBe(0);

    const tokens = await loginViaOtp(h, newEmail, resident.id);
    await h
      .http()
      .get(`${API}/units`)
      .set('Authorization', `Bearer ${tokens.accessToken}`)
      .expect(200);
  });

  it('a duplicate email on a contact change names the field', async () => {
    const created = await tenants.createTenant({
      name: 'Dup Court',
      manager: {
        fullName: 'Manager',
        nationalId: '29001018889990',
        phone: uniquePhone(),
        email: uniqueEmail('mgr'),
      },
    });
    const c = { tenantId: created.id, managerId: created.managers[0].id };
    const token = await h.tokenFor({
      sub: c.managerId,
      tid: c.tenantId,
      typ: 'manager',
    });
    const unit = await h
      .http()
      .post(`${API}/units`)
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'D-1' });
    const unitId = (unit.body as { id: string }).id;
    const asManager = <T>(fn: () => Promise<T>) =>
      cls.run(async () => {
        cls.set('tenantId', c.tenantId);
        cls.set('accountId', c.managerId);
        cls.set('accountType', 'manager');
        return await fn();
      });
    const taken = uniqueEmail('taken');
    await asManager(() =>
      residents.createResident({
        fullName: 'First',
        nationalId: '29001011010101',
        phone: uniquePhone(),
        email: taken,
        units: [{ unitId, occupancyType: 'owner' }],
      }),
    );
    const second = await asManager(() =>
      residents.createResident({
        fullName: 'Second',
        nationalId: '29001012020202',
        phone: uniquePhone(),
        email: uniqueEmail('second'),
        units: [{ unitId, occupancyType: 'tenant' }],
      }),
    );
    await expect(
      asManager(() => residents.updateContact(second.id, { email: taken })),
    ).rejects.toMatchObject({ code: 'P2002' });
    // Nothing was audited for the rolled-back change.
    expect(
      await read.tenant(c.tenantId, { action: 'account.contact_changed' }),
    ).toEqual([]);
  });
});
