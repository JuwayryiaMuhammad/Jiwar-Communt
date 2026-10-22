import { AUDIT_ACTIONS, SECURITY_EVENTS } from '../../src/core/audit/actions';
import { auditReaders } from '../setup/audit';
import { PARTNERS_COVERAGE } from '../setup/audit-coverage-split';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  partnersHelpers,
  type PartnersSetUp,
  type Who,
} from '../setup/partners';

/**
 * One scenario per partners catalog entry (ADR 0014, 0060): actor, target,
 * changes and metadata — ids, codes, counts and windows by value; never a
 * partner's names, description, phone or email, a resident's name or what
 * anyone wrote.
 */
const covered = new Set<string>();

/** Planted in every free text a scenario writes: no audit row may hold it. */
const MARKER = 'AUDIT-FREE-TEXT';

describe('Audit coverage — partners', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof partnersHelpers>;
  let s: PartnersSetUp;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = partnersHelpers(h);
    s = await p.setUp();
    read = auditReaders(h);
  }, 180_000);

  afterAll(() => h.close());

  async function rows(action: string, targetId: string) {
    const found = await read.tenant(s.c.tenantId, { action, targetId });
    covered.add(action);
    for (const row of found) {
      const text = JSON.stringify(row);
      expect(text).not.toContain(MARKER);
      expect(text).not.toContain('+2022555');
    }
    return found;
  }
  async function single(action: string, targetId: string) {
    const found = await rows(action, targetId);
    expect(found).toHaveLength(1);
    return found[0];
  }
  const by = (who: Who, targetType: string) => ({
    actorType: 'account',
    actorId: who.id,
    targetType,
  });

  describe('the catalogue', () => {
    let partnerId: string;
    let cleaning: string;

    beforeAll(async () => {
      cleaning = await p.subcategory(s.c, 'cleaning');
      const res = await p
        .http('post', '/staff/partners', s.keeper.token, {
          nameEn: `${MARKER} cleaners`,
          nameAr: `${MARKER} منظفون`,
          descriptionEn: `${MARKER} since 1999`,
          businessPhone: '+20225550199',
          notifyEmail: 'audit-free-text@example.com',
          serviceBuildings: ['A'],
          services: [{ category: 'home_services', subcategoryId: cleaning }],
        })
        .expect(201);
      partnerId = (res.body as { id: string }).id;
    });

    it('partner.created — standing, area and services by value; names, description, phone and email only as changed', async () => {
      const row = await single('partner.created', partnerId);
      expect(row).toMatchObject(by(s.keeper, 'partner'));
      expect(row.changes).toMatchObject({
        status: { from: null, to: 'active' },
        homeVisit: { from: null, to: false },
        serviceBuildings: { from: null, to: ['A'] },
        services: { from: null, to: [`home_services:${cleaning}`] },
        nameEn: { changed: true },
        nameAr: { changed: true },
        descriptionEn: { changed: true },
        businessPhone: { changed: true },
        notifyEmail: { changed: true },
      });
    });

    it('partner.updated — what changed, the names only as changed; nothing when nothing changed', async () => {
      await p
        .http('patch', `/staff/partners/${partnerId}`, s.keeper.token, {
          nameEn: `${MARKER} cleaners 2`,
          homeVisit: true,
        })
        .expect(200);
      await p
        .http('patch', `/staff/partners/${partnerId}`, s.keeper.token, {
          homeVisit: true,
        })
        .expect(200);
      const row = await single('partner.updated', partnerId);
      expect(row).toMatchObject(by(s.keeper, 'partner'));
      expect(row.changes).toEqual({
        nameEn: { changed: true },
        homeVisit: { from: false, to: true },
      });
    });

    it('partner.services_changed — the services as codes', async () => {
      await p
        .http('put', `/staff/partners/${partnerId}/services`, s.keeper.token, {
          services: [
            { category: 'home_services', subcategoryId: cleaning },
            { category: 'pets' },
          ],
        })
        .expect(200);
      const row = await single('partner.services_changed', partnerId);
      expect(row).toMatchObject(by(s.keeper, 'partner'));
      expect(row.changes).toEqual({
        services: {
          from: [`home_services:${cleaning}`],
          to: [`home_services:${cleaning}`, 'pets'],
        },
      });
    });

    it('partner.hours_changed — the windows as codes', async () => {
      await p
        .http('put', `/staff/partners/${partnerId}/hours`, s.keeper.token, {
          windows: [{ weekday: 1, startMinute: 540, endMinute: 1020 }],
        })
        .expect(200);
      const row = await single('partner.hours_changed', partnerId);
      expect(row.changes).toEqual({
        windows: { from: [], to: ['1:540-1020'] },
      });
    });

    it('partner.prices_changed — the lines as unit and price, never their names', async () => {
      await p
        .http('put', `/staff/partners/${partnerId}/prices`, s.keeper.token, {
          items: [
            {
              nameEn: `${MARKER} visit`,
              nameAr: `${MARKER} زيارة`,
              price: '150.5',
              unit: 'visit_fee',
              subcategoryId: cleaning,
            },
          ],
        })
        .expect(200);
      const row = await single('partner.prices_changed', partnerId);
      expect(row.changes).toEqual({
        items: { from: [], to: ['visit_fee:150.50'] },
      });
    });

    it('partner_subcategory.created and .updated — key and category by value, names as changed', async () => {
      const res = await p
        .http('post', '/staff/partner-subcategories', s.keeper.token, {
          category: 'home_services',
          key: 'windows',
          nameEn: `${MARKER} windows`,
          nameAr: `${MARKER} نوافذ`,
        })
        .expect(201);
      const id = (res.body as { id: string }).id;
      const created = await single('partner_subcategory.created', id);
      expect(created).toMatchObject(by(s.keeper, 'partner_subcategory'));
      expect(created.changes).toMatchObject({
        category: { from: null, to: 'home_services' },
        key: { from: null, to: 'windows' },
        nameEn: { changed: true },
      });
      await p
        .http('patch', `/staff/partner-subcategories/${id}`, s.keeper.token, {
          nameAr: `${MARKER} نوافذ ٢`,
          active: false,
        })
        .expect(200);
      const updated = await single('partner_subcategory.updated', id);
      expect(updated.changes).toEqual({
        nameAr: { changed: true },
        active: { from: true, to: false },
      });
    });

    it('partner.settings_changed — the settings by value', async () => {
      await p
        .http('patch', '/staff/partner-settings', s.manager.token, {
          newDays: 10,
          deskLinkDays: 30,
        })
        .expect(200);
      const row = await single('partner.settings_changed', s.c.tenantId);
      expect(row).toMatchObject(by(s.manager, 'tenant'));
      expect(row.changes).toEqual({
        newDays: { from: 30, to: 10 },
        deskLinkDays: { from: 90, to: 30 },
      });
    });
  });

  describe('catalog completeness', () => {
    it('every partners entry has a scenario above, and nothing of the domain is left out of the list', () => {
      const all = [...Object.keys(AUDIT_ACTIONS), ...SECURITY_EVENTS];
      for (const key of PARTNERS_COVERAGE) expect(all).toContain(key);
      expect([...covered].sort()).toEqual([...PARTNERS_COVERAGE].sort());
      expect(all.filter((k) => /^partner[._]/.test(k)).sort()).toEqual(
        [...PARTNERS_COVERAGE].sort(),
      );
    });
  });
});
