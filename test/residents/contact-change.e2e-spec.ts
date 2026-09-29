import { ClsService } from 'nestjs-cls';
import { IdentifierHasher } from '../../src/core/auth/identifier';
import type { AppClsStore } from '../../src/core/common/cls/app-cls';
import { newId } from '../../src/core/common/uuid';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { PrismaService } from '../../src/core/database/prisma.service';
import { ResidentsService } from '../../src/community/residents/residents.service';
import {
  API,
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { requestAndVerify } from '../setup/login';
import { countEmails } from '../setup/mailpit';

/**
 * Separate accounts per capacity, even on one phone (ADR 0002): changing one
 * account's phone must not touch the other account that shares it.
 */
describe('Contact change with two accounts on one phone', () => {
  let h: HttpHarness;
  let cls: ClsService<AppClsStore>;

  beforeAll(async () => {
    h = await createHttpHarness();
    cls = h.moduleRef.get<ClsService<AppClsStore>>(ClsService);
  });

  afterAll(() => h.close());

  it('the resident moves to a new phone; the staff account keeps the old one', async () => {
    const tenant = await h.createTenant('Shared Phone Court');
    const manager = await h.createAccount(tenant.id, {
      type: 'manager',
      email: uniqueEmail('mgr'),
      phone: uniquePhone(),
    });
    const asManager = <T>(fn: () => Promise<T>) =>
      cls.run(async () => {
        cls.set('tenantId', tenant.id);
        cls.set('accountId', manager.id);
        cls.set('accountType', 'manager');
        return await fn();
      });

    // No default staff role exists yet (ADR 0010); this compound gets one.
    await asManager(() =>
      h.moduleRef.get(PrismaService).tenant.role.create({
        data: { id: newId(), tenantId: tenant.id, key: 'staff', kind: 'staff' },
      }),
    );

    const sharedPhone = uniquePhone();
    const residentEmail = uniqueEmail('res');
    const staffEmail = uniqueEmail('staff');
    const resident = await h.createAccount(tenant.id, {
      type: 'resident',
      email: residentEmail,
      phone: sharedPhone,
    });
    const staff = await h.createAccount(tenant.id, {
      type: 'staff',
      email: staffEmail,
      phone: sharedPhone,
    });

    const newPhone = uniquePhone();
    await asManager(() =>
      h.moduleRef
        .get(ResidentsService)
        .updateContact(resident.id, { phone: newPhone }),
    );

    // Only the resident's lookup row moved.
    const hasher = h.moduleRef.get(IdentifierHasher);
    const rowsFor = (phone: string) =>
      h.moduleRef.get(GlobalDbService).loginIdentifier.findMany({
        where: {
          identifierHash: hasher.hashIdentifier({
            type: 'phone',
            value: phone,
          }),
        },
      });
    expect((await rowsFor(sharedPhone)).map((r) => r.accountId)).toEqual([
      staff.id,
    ]);
    expect((await rowsFor(newPhone)).map((r) => r.accountId)).toEqual([
      resident.id,
    ]);

    // The staff account still logs in with the old phone — and only it.
    const since = new Date();
    const viaOld = await requestAndVerify(h, sharedPhone, staffEmail);
    expect(viaOld.accounts.map((a) => [a.accountId, a.accountType])).toEqual([
      [staff.id, 'staff'],
    ]);
    expect(await countEmails(residentEmail, since)).toBe(0);
    const staffTokens = await h
      .http()
      .post(`${API}/auth/select-account`)
      .send({ loginTicket: viaOld.loginTicket, accountId: staff.id })
      .expect(200);
    const me = await h
      .http()
      .get(`${API}/accounts/me`)
      .set(
        'Authorization',
        `Bearer ${(staffTokens.body as { accessToken: string }).accessToken}`,
      )
      .expect(200);
    expect(me.body).toMatchObject({
      id: staff.id,
      type: 'staff',
      phone: sharedPhone,
    });

    // The resident logs in with the new phone.
    const viaNew = await requestAndVerify(h, newPhone, residentEmail);
    expect(viaNew.accounts.map((a) => [a.accountId, a.accountType])).toEqual([
      [resident.id, 'resident'],
    ]);
  });

  it('uses exactly the creation uniqueness rule: same phone across types yes, within a type no', async () => {
    const tenant = await h.createTenant('Uniqueness Court');
    const manager = await h.createAccount(tenant.id, {
      type: 'manager',
      email: uniqueEmail('mgr'),
      phone: uniquePhone(),
    });
    const asManager = <T>(fn: () => Promise<T>) =>
      cls.run(async () => {
        cls.set('tenantId', tenant.id);
        cls.set('accountId', manager.id);
        cls.set('accountType', 'manager');
        return await fn();
      });
    const residents = h.moduleRef.get(ResidentsService);
    const a = await h.createAccount(tenant.id, {
      type: 'resident',
      email: uniqueEmail('a'),
      phone: uniquePhone(),
    });
    const b = await h.createAccount(tenant.id, {
      type: 'resident',
      email: uniqueEmail('b'),
      phone: uniquePhone(),
    });

    // Taking the manager's phone: a different type, allowed — as at creation.
    const managerPhone = (
      await asManager(() =>
        h.moduleRef
          .get(PrismaService)
          .tenant.account.findUniqueOrThrow({ where: { id: manager.id } }),
      )
    ).phone;
    await expect(
      asManager(() => residents.updateContact(a.id, { phone: managerPhone })),
    ).resolves.toMatchObject({
      id: a.id,
      phone: managerPhone,
    });

    // Taking another resident's phone: the same type, rejected — as at creation.
    const bPhone = (
      await asManager(() =>
        h.moduleRef
          .get(PrismaService)
          .tenant.account.findUniqueOrThrow({ where: { id: b.id } }),
      )
    ).phone;
    await expect(
      asManager(() => residents.updateContact(a.id, { phone: bPhone })),
    ).rejects.toMatchObject({
      code: 'P2002',
    });
  });
});
