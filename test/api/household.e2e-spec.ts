import { RolesService } from '../../src/core/access/roles.service';
import { bornYearsAgo } from '../setup/fixtures';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { keyPaths, listKeys } from './keys';
import { call } from './request';
import { inviteBody, minorBody } from './routes/household';
import { buildWorld, type World } from './world';

const MEMBER = ['createdAt', 'fullName', 'id', 'isMinor', 'relation', 'status'];
const ITEM = ['fullName', 'id', 'isMinor', 'relation', 'status'];
const CREATED_INVITE = ['expiresAt', 'inviteId', 'token'];

describe('API v0 — household', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  async function home() {
    const unit = await w.helpers.unit(w.a);
    const owner = await w.helpers.resident(w.a, [unit.id]);
    const family = await w.helpers.joinFamily(w.a, unit.id, owner);
    return {
      unitId: unit.id,
      owner: await w.tokenFor(w.a, owner.id, 'resident'),
      family: await w.tokenFor(w.a, family.id, 'family'),
      familyMemberId: family.memberId,
    };
  }

  it('the household: permissions and invites for the primary only', async () => {
    const hm = await home();
    const invite = await call(
      w,
      'POST',
      `/units/${hm.unitId}/household/invites`,
      {
        token: hm.owner,
        body: inviteBody(),
      },
    ).expect(201);
    expect(invite.headers['cache-control']).toBe('no-store');
    expect(keyPaths(invite.body)).toEqual(CREATED_INVITE);

    const asPrimary = await call(w, 'GET', `/units/${hm.unitId}/household`, {
      token: hm.owner,
    }).expect(200);
    expect(keyPaths(asPrimary.body)).toEqual(
      [
        'invites',
        'invites[].expiresAt',
        'invites[].fullName',
        'invites[].id',
        'invites[].relation',
        'members',
        ...ITEM.map((k) => `members[].${k}`),
        'members[].permissions',
        'members[].permissions[].capPerOperation',
        'members[].permissions[].permission',
      ].sort(),
    );
    const asMember = await call(w, 'GET', `/units/${hm.unitId}/household`, {
      token: hm.family,
    }).expect(200);
    expect(keyPaths(asMember.body)).toEqual(
      ['members', ...ITEM.map((k) => `members[].${k}`)].sort(),
    );
    // The landlord of another unit: not their household.
    await call(w, 'GET', `/units/${hm.unitId}/household`, {
      token: w.a.tokens.landlord,
    }).expect(404);

    await call(
      w,
      'POST',
      `/household/invites/${(invite.body as { inviteId: string }).inviteId}/revoke`,
      {
        token: hm.owner,
      },
    ).expect(204);
  });

  it('the management sees which permissions each member holds: codes only, with residents.read', async () => {
    const hm = await home();
    const minor = await call(
      w,
      'POST',
      `/units/${hm.unitId}/household/minors`,
      { token: hm.owner, body: minorBody() },
    ).expect(201);
    const minorId = (minor.body as { id: string }).id;
    type Body = {
      members: { id: string; grantedPermissions?: string[] }[];
    };
    const asManager = async () => {
      const res = await call(w, 'GET', `/units/${hm.unitId}/household`, {
        token: w.a.tokens.manager,
      }).expect(200);
      return res;
    };
    const held = (body: Body, id: string) =>
      body.members.find((m) => m.id === id)?.grantedPermissions;

    const first = await asManager();
    // Codes: no cap, no `permissions`, no invites.
    expect(keyPaths(first.body)).toEqual(
      [
        'members',
        ...ITEM.map((k) => `members[].${k}`),
        'members[].grantedPermissions',
      ].sort(),
    );
    expect(first.text).not.toContain('capPerOperation');
    expect([...held(first.body as Body, hm.familyMemberId)!].sort()).toEqual([
      'bookings',
      'tickets',
      'visitors_invite',
    ]);
    // A minor holds nothing: an empty list, not an absent one.
    expect(held(first.body as Body, minorId)).toEqual([]);

    // What the manager revokes leaves the list at once.
    await call(
      w,
      'POST',
      `/household/members/${hm.familyMemberId}/permissions/revoke-by-management`,
      {
        token: w.a.tokens.manager,
        body: { permission: 'tickets', reasonCode: 'misuse', reason: 'x' },
      },
    ).expect(204);
    expect(
      [...held((await asManager()).body as Body, hm.familyMemberId)!].sort(),
    ).toEqual(['bookings', 'visitors_invite']);

    // The primary's and a member's views are what they were.
    const asPrimary = await call(w, 'GET', `/units/${hm.unitId}/household`, {
      token: hm.owner,
    }).expect(200);
    expect(keyPaths(asPrimary.body)).not.toContain(
      'members[].grantedPermissions',
    );
    const asMember = await call(w, 'GET', `/units/${hm.unitId}/household`, {
      token: hm.family,
    }).expect(200);
    expect(keyPaths(asMember.body)).toEqual(
      ['members', ...ITEM.map((k) => `members[].${k}`)].sort(),
    );

    // A manager whose role does not read residents: members, no codes.
    const roles = h.moduleRef.get(RolesService);
    const role = await w.helpers.asManager(w.a, async () =>
      (await roles.list()).find((r) => r.key === 'manager')!,
    );
    await w.helpers.asManager(w.a, () =>
      roles.replacePermissions(
        role.id,
        role.permissions.filter((p) => p !== 'residents.read'),
      ),
    );
    try {
      expect(keyPaths((await asManager()).body)).toEqual(
        ['members', ...ITEM.map((k) => `members[].${k}`)].sort(),
      );
    } finally {
      await w.helpers.asManager(w.a, () =>
        roles.replacePermissions(role.id, role.permissions),
      );
    }
    expect(keyPaths((await asManager()).body)).toContain(
      'members[].grantedPermissions',
    );
  });

  it('minors, coming of age, and removal', async () => {
    const hm = await home();
    const minor = await call(
      w,
      'POST',
      `/units/${hm.unitId}/household/minors`,
      {
        token: hm.owner,
        body: minorBody(),
      },
    ).expect(201);
    expect(keyPaths(minor.body)).toEqual(MEMBER);
    const minorId = (minor.body as { id: string }).id;

    await w.helpers.asManager(w.a, () =>
      w.helpers.prisma.tenant.householdMember.update({
        where: { id: minorId },
        data: { birthDate: bornYearsAgo(18, 1) },
      }),
    );
    const ready = await call(
      w,
      'GET',
      `/units/${hm.unitId}/household/minors-ready`,
      {
        token: hm.owner,
      },
    ).expect(200);
    expect(keyPaths(ready.body)).toEqual(listKeys(MEMBER));
    const majority = await call(
      w,
      'POST',
      `/household/members/${minorId}/majority-invite`,
      {
        token: hm.owner,
        body: { email: inviteBody().email, phone: inviteBody().phone },
      },
    ).expect(201);
    expect(majority.headers['cache-control']).toBe('no-store');
    expect(keyPaths(majority.body)).toEqual(CREATED_INVITE);

    await call(w, 'POST', `/household/members/${hm.familyMemberId}/remove`, {
      token: hm.owner,
      body: { reasonCode: 'moved_out', reason: 'Moved abroad' },
    }).expect(204);
  });

  it('management: pending approvals, approve, reject, remove during a separation', async () => {
    const manager = w.a.tokens.manager;
    await call(w, 'PATCH', '/settings', {
      token: manager,
      body: { familyJoinRequiresApproval: true },
    }).expect(200);
    try {
      const unit = await w.helpers.unit(w.a);
      const owner = await w.helpers.resident(w.a, [unit.id]);
      const first = await w.helpers.joinFamily(w.a, unit.id, owner);
      const second = await w.helpers.joinFamily(w.a, unit.id, owner, {
        relation: 'parent',
      });

      const pending = await call(w, 'GET', '/household/pending', {
        token: manager,
      }).expect(200);
      expect(keyPaths(pending.body)).toEqual(
        listKeys([
          'fullName',
          'kinshipDocuments',
          'memberId',
          'relation',
          'requestedAt',
          'unitCode',
          'unitId',
        ]),
      );
      const approved = await call(
        w,
        'POST',
        `/household/members/${first.memberId}/approve`,
        {
          token: manager,
        },
      ).expect(200);
      expect(keyPaths(approved.body)).toEqual(MEMBER);
      expect(approved.body).toMatchObject({ status: 'active' });
      await call(w, 'POST', `/household/members/${second.memberId}/reject`, {
        token: manager,
        body: { reasonCode: 'not_a_member', reason: 'Not family' },
      }).expect(204);

      await call(w, 'POST', `/units/${unit.id}/separation`, {
        token: manager,
        body: { reasonCode: 'separation', reason: 'Private' },
      }).expect(201);
      await call(
        w,
        'POST',
        `/household/members/${first.memberId}/remove-by-management`,
        {
          token: manager,
          body: { reasonCode: 'separation', reason: 'Separated' },
        },
      ).expect(204);
    } finally {
      await call(w, 'PATCH', '/settings', {
        token: manager,
        body: { familyJoinRequiresApproval: false },
      }).expect(200);
    }
  });
});
