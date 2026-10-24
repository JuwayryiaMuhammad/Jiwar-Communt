import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  partnersHelpers,
  type PartnerBody,
  type PartnersSetUp,
  type Who,
} from '../setup/partners';

interface StaffPartnerBody extends PartnerBody {
  notifyEmail: string | null;
  status: string;
  suspendedReason: string | null;
}

/**
 * The partner catalogue's set-up (ADR 0060): who a partner is, what it
 * does, its prices, hours and area, the compound's sub-categories and
 * settings, kept with `partners.manage`.
 */
describe('Partners: the catalogue (ADR 0060)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof partnersHelpers>;
  let s: PartnersSetUp;
  let cleaning: string;
  let carpets: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = partnersHelpers(h);
    s = await p.setUp();
    cleaning = await p.subcategory(s.c, 'cleaning');
    carpets = await p.subcategory(s.c, 'carpets');
  }, 180_000);

  afterAll(() => h.close());

  const create = (body: object, as: Who = s.keeper) =>
    p.http('post', '/staff/partners', as.token, body);
  const staffGet = async (id: string) =>
    (await p.http('get', `/staff/partners/${id}`, s.keeper.token).expect(200))
      .body as StaffPartnerBody;
  const fields = (res: { body: unknown }) =>
    (res.body as { fields: unknown[] }).fields;
  const base = () => ({
    nameEn: 'Sparkle',
    nameAr: 'سباركل',
    businessPhone: '01001234567',
    services: [{ category: 'home_services', subcategoryId: cleaning }],
  });

  describe('listing a partner', () => {
    it('is active and listed now, its phone stored E.164, its email lower-cased, with no hours and no prices', async () => {
      const res = await create({
        ...base(),
        nameEn: '  Sparkle  ',
        notifyEmail: 'Desk@Sparkle.Example',
        serviceBuildings: ['B', 'A', 'A'],
        homeVisit: true,
      }).expect(201);
      const body = res.body as StaffPartnerBody;
      expect(body).toMatchObject({
        nameEn: 'Sparkle',
        businessPhone: '+201001234567',
        notifyEmail: 'desk@sparkle.example',
        serviceBuildings: ['A', 'B'],
        homeVisit: true,
        status: 'active',
        suspendedReason: null,
        hours: [],
        priceItems: [],
        services: [
          {
            category: 'home_services',
            subcategory: { id: cleaning, key: 'cleaning' },
          },
        ],
      });
    });

    it('a blank name is missing; a building nobody’s unit names, a sub-category of another category, a pair twice are refused', async () => {
      expect(
        fields(await create({ ...base(), nameAr: '   ' }).expect(400)),
      ).toEqual([{ field: 'nameAr', code: 'FIELD_REQUIRED' }]);
      expect(
        fields(
          await create({ ...base(), serviceBuildings: ['A', 'Z'] }).expect(400),
        ),
      ).toEqual([{ field: 'serviceBuildings.1', code: 'INVALID_VALUE' }]);
      expect(
        fields(
          await create({
            ...base(),
            services: [{ category: 'pets', subcategoryId: cleaning }],
          }).expect(400),
        ),
      ).toEqual([
        {
          field: 'services.0.subcategoryId',
          code: 'PARTNER_SUBCATEGORY_NOT_AVAILABLE',
        },
      ]);
      expect(
        fields(
          await create({
            ...base(),
            services: [{ category: 'pets' }, { category: 'pets' }],
          }).expect(400),
        ),
      ).toEqual([{ field: 'services.1', code: 'DUPLICATE_VALUE' }]);
      expect(
        fields(await create({ ...base(), services: [] }).expect(400)),
      ).toEqual([
        {
          field: 'services',
          code: 'INVALID_LENGTH',
          params: { min: 1, max: 30 },
        },
      ]);
    });

    it('a retired sub-category is offered for nothing new; the partners that name it keep it', async () => {
      const id = await p.partner(s.c, s.keeper, {
        services: [{ category: 'laundry', subcategoryId: carpets }],
      });
      await p
        .http(
          'patch',
          `/staff/partner-subcategories/${carpets}`,
          s.keeper.token,
          {
            active: false,
          },
        )
        .expect(200);
      expect((await staffGet(id)).services).toEqual([
        {
          category: 'laundry',
          subcategory: expect.objectContaining({ id: carpets }) as object,
        },
      ]);
      expect(
        fields(
          await create({
            ...base(),
            services: [{ category: 'laundry', subcategoryId: carpets }],
          }).expect(400),
        ),
      ).toEqual([
        {
          field: 'services.0.subcategoryId',
          code: 'PARTNER_SUBCATEGORY_NOT_AVAILABLE',
        },
      ]);
      await p
        .http(
          'patch',
          `/staff/partner-subcategories/${carpets}`,
          s.keeper.token,
          {
            active: true,
          },
        )
        .expect(200);
    });

    it('only partners.manage keeps partners: a resident and a guard are refused', async () => {
      await create(base(), s.alice).expect(403);
      const guard = await p.staff(s.c, []);
      await create(base(), guard).expect(403);
      await p.http('get', '/staff/partners', s.alice.token).expect(403);
    });
  });

  describe('changing a partner', () => {
    let id: string;

    beforeAll(async () => {
      id = await p.partner(s.c, s.keeper);
    });

    it('names, phone, email and area; null clears the email and a description', async () => {
      await p
        .http('patch', `/staff/partners/${id}`, s.keeper.token, {
          descriptionEn: 'Since 1999',
          notifyEmail: 'desk@example.com',
        })
        .expect(200);
      const res = await p
        .http('patch', `/staff/partners/${id}`, s.keeper.token, {
          descriptionEn: null,
          notifyEmail: null,
          businessPhone: '+201112223334',
          serviceBuildings: [],
        })
        .expect(200);
      expect(res.body).toMatchObject({
        descriptionEn: null,
        notifyEmail: null,
        businessPhone: '+201112223334',
        serviceBuildings: [],
      });
    });

    it('its standing is not changed here', async () => {
      const res = await p
        .http('patch', `/staff/partners/${id}`, s.keeper.token, {
          status: 'suspended',
        })
        .expect(400);
      expect(fields(res)).toEqual([
        { field: 'status', code: 'FIELD_NOT_ALLOWED' },
      ]);
    });

    it('services are replaced as a whole', async () => {
      const res = await p
        .http('put', `/staff/partners/${id}/services`, s.keeper.token, {
          services: [{ category: 'pets' }, { category: 'gardening' }],
        })
        .expect(200);
      expect(
        (res.body as StaffPartnerBody).services.map((x) => x.category).sort(),
      ).toEqual(['gardening', 'pets']);
    });

    it('hours are replaced as a whole; windows of a day may touch, never overlap', async () => {
      const res = await p
        .http('put', `/staff/partners/${id}/hours`, s.keeper.token, {
          windows: [
            { weekday: 2, startMinute: 0, endMinute: 120 },
            { weekday: 1, startMinute: 1080, endMinute: 1440 },
            { weekday: 1, startMinute: 540, endMinute: 1080 },
          ],
        })
        .expect(200);
      expect((res.body as StaffPartnerBody).hours).toEqual([
        { weekday: 1, startMinute: 540, endMinute: 1080 },
        { weekday: 1, startMinute: 1080, endMinute: 1440 },
        { weekday: 2, startMinute: 0, endMinute: 120 },
      ]);
      const overlap = await p
        .http('put', `/staff/partners/${id}/hours`, s.keeper.token, {
          windows: [
            { weekday: 1, startMinute: 540, endMinute: 700 },
            { weekday: 1, startMinute: 600, endMinute: 800 },
          ],
        })
        .expect(400);
      expect(fields(overlap)).toEqual([
        {
          field: 'windows.1.startMinute',
          code: 'WINDOW_OVERLAP',
          params: { other: 0 },
        },
      ]);
    });

    it('prices are replaced as a whole, in order, in EGP; a line’s sub-category is one the partner offers', async () => {
      await p
        .http('put', `/staff/partners/${id}/services`, s.keeper.token, {
          services: [{ category: 'home_services', subcategoryId: cleaning }],
        })
        .expect(200);
      const res = await p
        .http('put', `/staff/partners/${id}/prices`, s.keeper.token, {
          items: [
            {
              nameEn: 'Visit',
              nameAr: 'زيارة',
              price: '100',
              unit: 'visit_fee',
            },
            {
              nameEn: 'Flat',
              nameAr: 'شقة',
              price: '850.5',
              unit: 'fixed',
              subcategoryId: cleaning,
            },
          ],
        })
        .expect(200);
      expect(
        (res.body as StaffPartnerBody).priceItems.map((i) => [
          i.nameEn,
          i.price,
          i.unit,
          i.subcategoryId,
        ]),
      ).toEqual([
        ['Visit', '100.00', 'visit_fee', null],
        ['Flat', '850.50', 'fixed', cleaning],
      ]);
      const refused = await p
        .http('put', `/staff/partners/${id}/prices`, s.keeper.token, {
          items: [
            {
              nameEn: 'Carpet',
              nameAr: 'سجادة',
              price: '50',
              unit: 'per_sqm',
              subcategoryId: carpets,
            },
          ],
        })
        .expect(400);
      expect(fields(refused)).toEqual([
        {
          field: 'items.0.subcategoryId',
          code: 'PARTNER_SERVICE_NOT_OFFERED',
        },
      ]);
    });

    it('an unknown or another compound’s partner is not found', async () => {
      const other = await p.setUp();
      const theirs = await p.partner(other.c, other.keeper);
      await p
        .http('patch', `/staff/partners/${theirs}`, s.keeper.token, {
          homeVisit: true,
        })
        .expect(404);
    });
  });

  describe('sub-categories', () => {
    it('a key names one in the compound; its category and key never change', async () => {
      await p
        .http('post', '/staff/partner-subcategories', s.keeper.token, {
          category: 'repair',
          key: 'laptops',
          nameEn: 'Laptops',
          nameAr: 'لابتوب',
        })
        .expect(201);
      const twice = await p
        .http('post', '/staff/partner-subcategories', s.keeper.token, {
          category: 'pets',
          key: 'laptops',
          nameEn: 'Again',
          nameAr: 'مرة',
        })
        .expect(409);
      expect(twice.body).toMatchObject({
        code: 'DUPLICATE_RESOURCE',
        fields: [{ field: 'key', code: 'DUPLICATE_VALUE' }],
      });
    });

    it('residents read the closed list in order, each with its active sub-categories and its consent', async () => {
      const res = await p
        .http('get', '/partner-categories', s.alice.token)
        .expect(200);
      const data = (
        res.body as {
          data: {
            category: string;
            consentCode: string;
            subcategories: { key: string }[];
          }[];
        }
      ).data;
      expect(data.map((c) => c.category)).toEqual([
        'gas_water',
        'pharmacy',
        'grocery',
        'home_services',
        'laundry',
        'gardening',
        'beauty_at_home',
        'repair',
        'pets',
        'events',
        'moving_storage',
        'car_services',
        'elderly_care',
      ]);
      expect(data[3]).toMatchObject({
        category: 'home_services',
        consentCode: 'partner_share_home_services',
      });
      expect(data[3].subcategories.map((x) => x.key)).toEqual([
        'cleaning',
        'pest_control',
        'air_conditioning',
      ]);
    });
  });

  describe('settings', () => {
    it('are the compound’s, by value, within their ranges', async () => {
      const res = await p
        .http('get', '/staff/partner-settings', s.manager.token)
        .expect(200);
      expect(res.body).toEqual({
        newDays: 30,
        lateFromMinute: 1320,
        maxLiveRequests: 5,
        ratingDays: 14,
        complaintDays: 14,
        deskLinkDays: 90,
      });
      const refused = await p
        .http('patch', '/staff/partner-settings', s.manager.token, {
          lateFromMinute: 600,
        })
        .expect(400);
      expect(fields(refused)).toEqual([
        {
          field: 'lateFromMinute',
          code: 'INVALID_NUMBER',
          params: { min: 960, max: 1439 },
        },
      ]);
    });
  });
});
