import { PlatformModule } from '../../src/core/platform/platform.module';
import { TenantSettingsService } from '../../src/core/tenant-settings/tenant-settings.service';
import { auditReaders } from '../setup/audit';
import { communityHelpers } from '../setup/community';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';

/** A compound's own settings (ADR 0016). */
describe('Tenant settings', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let settings: TenantSettingsService;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    settings = h.moduleRef.get(TenantSettingsService);
  });

  afterAll(() => h.close());

  it('a new compound starts with the defaults', async () => {
    const c = await x.compound();
    expect(await x.asManager(c, () => settings.get())).toEqual({
      familyJoinRequiresApproval: false,
      maxHouseholdMembers: 10,
    });
  });

  it('the manager changes them, per compound, audited with before and after', async () => {
    const c = await x.compound();
    const other = await x.compound();
    const updated = await x.asManager(c, () =>
      settings.update({
        familyJoinRequiresApproval: true,
        maxHouseholdMembers: 4,
      }),
    );
    expect(updated).toEqual({
      familyJoinRequiresApproval: true,
      maxHouseholdMembers: 4,
    });
    expect(await x.asManager(other, () => settings.get())).toEqual({
      familyJoinRequiresApproval: false,
      maxHouseholdMembers: 10,
    });

    const [entry] = await auditReaders(h).tenant(c.tenantId, {
      action: 'tenant.settings_changed',
    });
    expect(entry.changes).toEqual({
      familyJoinRequiresApproval: { from: false, to: true },
      maxHouseholdMembers: { from: 10, to: 4 },
    });

    // No change, no entry.
    await x.asManager(c, () => settings.update({ maxHouseholdMembers: 4 }));
    expect(
      await auditReaders(h).tenant(c.tenantId, {
        action: 'tenant.settings_changed',
      }),
    ).toHaveLength(1);
  });

  it.each([0, 101, 2.5])('rejects a household limit of %p', async (value) => {
    const c = await x.compound();
    await expect(
      x.asManager(c, () => settings.update({ maxHouseholdMembers: value })),
    ).rejects.toMatchObject({
      response: {
        code: 'VALIDATION_FAILED',
        fields: [
          {
            field: 'maxHouseholdMembers',
            code: 'INVALID_NUMBER',
            params: { min: 1, max: 100 },
          },
        ],
      },
    });
  });
});
