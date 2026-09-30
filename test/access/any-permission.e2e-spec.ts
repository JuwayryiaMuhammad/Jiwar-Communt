import { Controller, Get } from '@nestjs/common';
import { RequireAnyPermission } from '../../src/core/access/require-permissions.decorator';
import { RolesService } from '../../src/core/access/roles.service';
import { DEFAULT_ROLES } from '../../src/core/access/default-roles';
import { communityHelpers } from '../setup/community';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';

/** Test-only route: an action open to residents and managers. */
@Controller('probe-any')
class ProbeController {
  @RequireAnyPermission('workers.manage', 'workers.review')
  @Get()
  ok() {
    return { ok: true };
  }
}

describe('@RequireAnyPermission', () => {
  let h: HttpHarness;
  let c: ReturnType<typeof communityHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness({ controllers: [ProbeController] });
    c = communityHelpers(h);
  });

  afterAll(() => h.close());

  it('passes with any one of the permissions and fails with none', async () => {
    const compound = await c.compound();
    const unit = await c.unit(compound);
    const resident = await c.resident(compound, [unit.id]);
    const get = async (sub: string, typ: 'manager' | 'resident') =>
      h
        .http()
        .get(`${API}/probe-any`)
        .set(
          'Authorization',
          `Bearer ${await h.tokenFor({ sub, tid: compound.tenantId, typ })}`,
        );

    expect((await get(resident.id, 'resident')).status).toBe(200); // workers.manage
    expect((await get(compound.managerId, 'manager')).status).toBe(200); // workers.review

    // The manager role without workers.review has neither.
    const roles = h.moduleRef.get(RolesService);
    const managerDefaults = DEFAULT_ROLES.find((r) => r.key === 'manager')!;
    await c.asManager(compound, async () => {
      const role = (await roles.list()).find((r) => r.key === 'manager')!;
      await roles.replacePermissions(
        role.id,
        managerDefaults.permissions.filter((p) => p !== 'workers.review'),
      );
    });
    const denied = await get(compound.managerId, 'manager');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'FORBIDDEN' });
  });
});
