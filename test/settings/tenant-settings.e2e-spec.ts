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
      timezone: 'Africa/Cairo',
      maxActiveVisitorPasses: 50,
      gateRequestTimeoutSeconds: 180,
      visitorDirections: null,
      emergencyPhone: null,
    });
  });

  it('the gate settings are ranged (ADR 0028)', async () => {
    const c = await x.compound();
    expect(
      await x.asManager(c, () =>
        settings.update({
          maxActiveVisitorPasses: 5,
          gateRequestTimeoutSeconds: 60,
        }),
      ),
    ).toMatchObject({
      maxActiveVisitorPasses: 5,
      gateRequestTimeoutSeconds: 60,
    });
    for (const [field, value, range] of [
      ['maxActiveVisitorPasses', 0, { min: 1, max: 500 }],
      ['maxActiveVisitorPasses', 501, { min: 1, max: 500 }],
      ['gateRequestTimeoutSeconds', 29, { min: 30, max: 1800 }],
      ['gateRequestTimeoutSeconds', 1801, { min: 30, max: 1800 }],
    ] as const) {
      await expect(
        x.asManager(c, () => settings.update({ [field]: value })),
      ).rejects.toMatchObject({
        response: {
          fields: [{ field, code: 'INVALID_NUMBER', params: range }],
        },
      });
    }
  });

  it('the time zone must be a real IANA zone', async () => {
    const c = await x.compound();
    expect(
      await x.asManager(c, () => settings.update({ timezone: 'Asia/Dubai' })),
    ).toMatchObject({ timezone: 'Asia/Dubai' });
    await expect(
      x.asManager(c, () => settings.update({ timezone: 'Mars/Olympus' })),
    ).rejects.toMatchObject({
      response: { fields: [{ field: 'timezone', code: 'INVALID_VALUE' }] },
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
      timezone: 'Africa/Cairo',
      maxActiveVisitorPasses: 50,
      gateRequestTimeoutSeconds: 180,
      visitorDirections: null,
      emergencyPhone: null,
    });
    expect(await x.asManager(other, () => settings.get())).toEqual({
      familyJoinRequiresApproval: false,
      maxHouseholdMembers: 10,
      timezone: 'Africa/Cairo',
      maxActiveVisitorPasses: 50,
      gateRequestTimeoutSeconds: 180,
      visitorDirections: null,
      emergencyPhone: null,
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

  it('visitor directions and the emergency phone: set, normalized, cleared, audited without values (ADR 0030)', async () => {
    const c = await x.compound();
    const text = '  Gate 2, then the second left. Show the QR.  ';
    expect(
      await x.asManager(c, () =>
        settings.update({
          visitorDirections: text,
          emergencyPhone: '01000000123',
        }),
      ),
    ).toMatchObject({
      visitorDirections: text.trim(),
      emergencyPhone: '+201000000123',
    });
    // Absent keeps them.
    expect(
      await x.asManager(c, () => settings.update({ maxHouseholdMembers: 5 })),
    ).toMatchObject({
      visitorDirections: text.trim(),
      emergencyPhone: '+201000000123',
    });
    for (const [input, field, code, params] of [
      [
        { visitorDirections: '   ' },
        'visitorDirections',
        'INVALID_LENGTH',
        { min: 1, max: 2000 },
      ],
      [
        { visitorDirections: 'x'.repeat(2001) },
        'visitorDirections',
        'INVALID_LENGTH',
        { min: 1, max: 2000 },
      ],
      [{ emergencyPhone: '12' }, 'emergencyPhone', 'INVALID_PHONE', undefined],
    ] as const) {
      await expect(
        x.asManager(c, () => settings.update(input)),
      ).rejects.toMatchObject({
        response: {
          fields: [params ? { field, code, params } : { field, code }],
        },
      });
    }
    expect(
      await x.asManager(c, () =>
        settings.update({ visitorDirections: null, emergencyPhone: null }),
      ),
    ).toMatchObject({ visitorDirections: null, emergencyPhone: null });

    const entries = await auditReaders(h).tenant(c.tenantId, {
      action: 'tenant.settings_changed',
    });
    expect(entries.map((e) => e.changes)).toEqual([
      {
        visitorDirections: { changed: true },
        emergencyPhone: { changed: true },
      },
      { maxHouseholdMembers: { from: 10, to: 5 } },
      {
        visitorDirections: { changed: true },
        emergencyPhone: { changed: true },
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain('Gate 2');
    expect(JSON.stringify(entries)).not.toContain('1000000123');
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
