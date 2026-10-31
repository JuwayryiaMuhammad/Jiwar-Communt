import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../../src/core/common/uuid';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { createDbHarness, type DbHarness } from '../setup/db-module';
import { createAccountRow, createTenant, createUnit } from '../setup/fixtures';
import {
  albumRow,
  busDepartureRow,
  galleryPhotoRow,
  galleryReportRow,
  busRouteRow,
  listingRow,
  marketFileRow,
  groupOfferRow,
  groupParticipantRow,
  marketReportRow,
  partnerOfferRow,
  shopRow,
} from '../setup/market-rows';
import { partnerRow } from '../setup/partners-rows';

/** What a seed needs from one compound. */
interface Side {
  tenantId: string;
  unitId: string;
  accountId: string;
  listingId: string;
  /** An account with no shop, for the shop row (one open an account). */
  shopOwnerId: string;
  partnerId: string;
  groupOfferId: string;
  busRouteId: string;
  albumId: string;
  galleryPhotoId: string;
}

/**
 * One table of R11c-2: how to insert a row in a compound. `link` points the
 * row's foreign keys at another compound's rows, which the composite keys
 * must refuse; `key` is the column it is found by.
 */
interface Table {
  table: string;
  key?: string;
  insert(tx: TenantTxClient, own: Side, link: Side): Promise<string>;
  /** False when the row has no foreign key into another tenant table. */
  linked?: boolean;
  /**
   * A provisioned row is read back, not inserted: this writes a new one
   * for `own`, which acting as another compound must be refused.
   */
  forge?(tx: TenantTxClient, own: Side): Promise<unknown>;
}

/** Each photo its own position on its listing. */
let positions = 0;

/**
 * The tables of community (ADR 0071): isolated like every other tenant
 * table, linked with composite keys. The RLS coverage test checks the
 * policies exist; this suite checks they hold, table by table.
 */
const TABLES: Table[] = [
  {
    table: 'market_settings',
    key: 'tenant_id',
    linked: false,
    // Every compound has its row from the provisioning: read it back.
    insert: (tx, own) => Promise.resolve(own.tenantId),
    forge: (tx, own) =>
      tx.marketSettings.create({ data: { tenantId: own.tenantId } }),
  },
  {
    table: 'market_listings',
    insert: (tx, own, link) =>
      listingRow(tx, {
        tenantId: own.tenantId,
        sellerId: link.accountId,
        sellerUnitId: link.unitId,
      }),
  },
  {
    table: 'market_shops',
    // One open shop an account: the side's spare account runs it.
    insert: (tx, own, link) =>
      shopRow(tx, {
        tenantId: own.tenantId,
        ownerId: link.shopOwnerId,
        ownerUnitId: link.unitId,
      }),
  },
  {
    table: 'market_listing_reports',
    // A listing of the link's own each time: one report a reporter there.
    insert: async (tx, own, link) =>
      marketReportRow(tx, {
        tenantId: own.tenantId,
        listingId:
          own === link
            ? await listingRow(tx, {
                tenantId: own.tenantId,
                sellerId: own.accountId,
                sellerUnitId: own.unitId,
              })
            : link.listingId,
        reporterId: link.accountId,
        reporterUnitId: link.unitId,
      }),
  },
  {
    table: 'partner_offers',
    insert: (tx, own, link) =>
      partnerOfferRow(tx, {
        tenantId: own.tenantId,
        partnerId: link.partnerId,
        createdById: link.accountId,
      }),
  },
  {
    table: 'group_offers',
    insert: (tx, own, link) =>
      groupOfferRow(tx, {
        tenantId: own.tenantId,
        createdById: link.accountId,
        partnerId: link.partnerId,
      }),
  },
  {
    table: 'group_offer_participants',
    // A new offer of the link's each time: one live join an account there.
    insert: async (tx, own, link) =>
      groupParticipantRow(tx, {
        tenantId: own.tenantId,
        offerId:
          own === link
            ? await groupOfferRow(tx, {
                tenantId: own.tenantId,
                createdById: own.accountId,
              })
            : link.groupOfferId,
        accountId: link.accountId,
        unitId: link.unitId,
      }),
  },
  {
    table: 'bus_routes',
    linked: false,
    insert: (tx, own) => busRouteRow(tx, own.tenantId),
  },
  {
    table: 'bus_departures',
    insert: (tx, own, link) =>
      busDepartureRow(tx, own.tenantId, link.busRouteId),
  },
  {
    table: 'gallery_albums',
    insert: (tx, own, link) =>
      albumRow(tx, { tenantId: own.tenantId, createdById: link.accountId }),
  },
  {
    table: 'gallery_photos',
    insert: (tx, own, link) =>
      galleryPhotoRow(tx, { tenantId: own.tenantId, albumId: link.albumId }),
  },
  {
    table: 'gallery_photo_reports',
    // A new photo of the link's each time: one report a reporter there.
    insert: async (tx, own, link) =>
      galleryReportRow(tx, {
        tenantId: own.tenantId,
        photoId:
          own === link
            ? await galleryPhotoRow(tx, {
                tenantId: own.tenantId,
                albumId: own.albumId,
              })
            : link.galleryPhotoId,
        reporterId: link.accountId,
      }),
  },
  {
    table: 'market_listing_photos',
    insert: async (tx, own, link) => {
      const id = newId();
      await tx.marketListingPhoto.create({
        data: {
          id,
          tenantId: own.tenantId,
          listingId: link.listingId,
          fileId: await marketFileRow(tx, own.tenantId),
          position: positions++ % 6,
        },
      });
      return id;
    },
  },
];

describe('RLS isolation — community (ADR 0071)', () => {
  let h: DbHarness;
  let a: Side;
  let b: Side;
  const ids: Record<string, string> = {};

  const inTenant = <T>(s: Side, fn: (tx: TenantTxClient) => Promise<T>) =>
    h.asTenant(s.tenantId, () => h.tenantTx.withTenantTx(fn));

  const side = async (label: string): Promise<Side> => {
    const tenantId = await createTenant(h, `Community ${label}`);
    const s: Side = {
      tenantId,
      unitId: (await createUnit(h, tenantId)).id,
      accountId: (await createAccountRow(h, tenantId)).id,
      listingId: '',
      shopOwnerId: (await createAccountRow(h, tenantId)).id,
      partnerId: '',
      groupOfferId: '',
      busRouteId: '',
      albumId: '',
      galleryPhotoId: '',
    };
    await inTenant(s, async (tx) => {
      s.partnerId = await partnerRow(tx, {
        tenantId,
        createdById: s.accountId,
      });
      s.busRouteId = await busRouteRow(tx, tenantId);
      s.albumId = await albumRow(tx, { tenantId, createdById: s.accountId });
      s.galleryPhotoId = await galleryPhotoRow(tx, {
        tenantId,
        albumId: s.albumId,
      });
      s.groupOfferId = await groupOfferRow(tx, {
        tenantId,
        createdById: s.accountId,
      });
      s.listingId = await listingRow(tx, {
        tenantId,
        sellerId: s.accountId,
        sellerUnitId: s.unitId,
      });
    });
    return s;
  };

  beforeAll(async () => {
    h = await createDbHarness();
    a = await side('A');
    b = await side('B');
    for (const t of TABLES)
      ids[t.table] = await inTenant(a, (tx) => t.insert(tx, a, a));
  });

  afterAll(() => h.close());

  it('covers every table the phase’s migrations create', () => {
    const dir = join(__dirname, '../../prisma/migrations');
    const created = readdirSync(dir)
      .filter((m) => m >= '20270119090000' && m < '20270120')
      .flatMap((m) =>
        [
          ...readFileSync(join(dir, m, 'migration.sql'), 'utf8').matchAll(
            /CREATE TABLE "([a-z_]+)"/g,
          ),
        ].map((x) => x[1]),
      );
    expect(TABLES.map((t) => t.table).sort()).toEqual(created.sort());
  });

  describe.each(TABLES.map((t) => [t.table, t] as const))('%s', (name, t) => {
    const key = t.key ?? 'id';

    it('A sees its row; B does not, by its key or in a full scan', async () => {
      const count = (s: Side, all = false) =>
        inTenant(s, async (tx) => {
          const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "${name}" WHERE ${all ? `tenant_id = $1::uuid` : `"${key}" = $1::uuid`}`,
            all ? a.tenantId : ids[name],
          );
          return Number(rows[0].n);
        });
      expect(await count(a)).toBe(1);
      expect(await count(b)).toBe(0);
      expect(await count(b, true)).toBe(0);
    });

    it('B updates and deletes nothing of A', async () => {
      const run = (sql: string) =>
        inTenant(b, (tx) =>
          tx
            .$executeRawUnsafe(sql, ids[name])
            .catch((e: Error) =>
              /permission denied/.test(e.message) ? 0 : Promise.reject(e),
            ),
        );
      expect(
        await run(
          `UPDATE "${name}" SET tenant_id = tenant_id WHERE "${key}" = $1::uuid`,
        ),
      ).toBe(0);
      expect(await run(`DELETE FROM "${name}" WHERE "${key}" = $1::uuid`)).toBe(
        0,
      );
    });

    it('acting as B, a row with A’s tenant_id is refused', async () => {
      await expect(
        inTenant(b, (tx) => (t.forge ? t.forge(tx, a) : t.insert(tx, a, a))),
      ).rejects.toThrow(/row-level security/);
    });

    if (t.linked !== false) {
      it('a row may not point at another compound’s rows (composite keys)', async () => {
        await expect(inTenant(a, (tx) => t.insert(tx, a, b))).rejects.toThrow(
          /foreign key|violates/i,
        );
      });
    }
  });
});
