import { Client } from 'pg';
import { MARKET_LISTINGS_SWEEP } from '../../src/neighbours/market/market-lifecycle';
import { partnerRow } from './partners-rows';
import type { Compound } from './community';
import { dbClock } from './compound-clock';
import { buildExports, readArchive, stepUp } from './exports';
import { fileHelpers } from './files';
import { API, type HttpHarness } from './http-app';
import { neighboursHelpers, type Who } from './neighbours';
import { required } from './test-env';

export type { Who } from './neighbours';

export interface Listed {
  id: string;
  status: string;
}

/**
 * Helpers for the market suites (ADR 0071): the neighbours' compound (Alice
 * in building A, Bob in building B, a handler, the manager), the market's
 * settings, and the residents' and handlers' calls over HTTP.
 */
export function marketHelpers(h: HttpHarness) {
  const n = neighboursHelpers(h);
  const { x, http, list } = n;
  const files = fileHelpers(h);

  /**
   * The neighbours' compound, and a handler holding `market.handle` (the
   * manager holds it by default; a staff role is given it, as a manager
   * would in the roles screen).
   */
  async function setUp() {
    const s = await n.setUp();
    return {
      ...s,
      marketHandler: await n.staff(s.c, ['market.handle']),
    };
  }

  /** `PATCH /market/settings` as the manager. */
  function marketSettings(manager: Who, patch: Record<string, unknown>) {
    return http('patch', '/market/settings', manager.token, patch).expect(200);
  }

  /** `POST /market/listings`: the response. */
  const listRaw = (by: Who, over: Record<string, unknown> = {}) =>
    http('post', '/market/listings', by.token, {
      kind: 'sell',
      category: 'furniture',
      title: 'Oak dining table',
      body: 'Seats six, light scratches, collect from the lobby.',
      price: '1500.00',
      ...over,
    });

  async function listing(
    by: Who,
    over: Record<string, unknown> = {},
  ): Promise<Listed> {
    const res = await listRaw(by, over);
    if (res.status !== 201)
      throw new Error(`listing: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as Listed;
  }

  /** A handler's decision on a listing: `POST /market/review/{id}/{action}`. */
  const review = (
    by: Who,
    id: string,
    action: 'approve' | 'reject' | 'remove',
    reasonCode?: string,
  ) =>
    http(
      'post',
      `/market/review/${id}/${action}`,
      by.token,
      reasonCode ? { reasonCode } : {},
    );

  /** Listed and approved: live on the market. */
  async function live(
    by: Who,
    handler: Who,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const { id, status } = await listing(by, over);
    if (status === 'pending_review')
      await review(handler, id, 'approve').expect(204);
    return id;
  }

  /** The market as `by` searches it: the listings' bodies. */
  async function market<T = Record<string, unknown>>(
    by: Who,
    query = '',
  ): Promise<T[]> {
    return list<T>(`/market/listings${query ? `?${query}` : ''}`, by);
  }

  /** A finalized photo of the caller's for a listing. */
  const photo = (by: Who, contentType = 'image/png') =>
    files.ready(by.token, 'market_listing_photo', contentType);

  /**
   * Moves a listing's day into the past (and its listing back), as a
   * test's time machine: only a superuser with triggers off rewrites it.
   */
  async function expire(c: Compound, listingId: string): Promise<void> {
    const db = new Client({
      connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
    });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query(`SET LOCAL session_replication_role = replica`);
      await db.query(
        `UPDATE market_listings
            SET created_at = now() - interval '40 days',
                expires_at = now() - interval '1 day'
          WHERE id = $1 AND tenant_id = $2`,
        [listingId, c.tenantId],
      );
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
  }

  /** Brings a listing's day to within the notice: one day from now. */
  async function nearExpiry(c: Compound, listingId: string): Promise<void> {
    const db = new Client({
      connectionString: required('TEST_SUPERUSER_DATABASE_URL'),
    });
    await db.connect();
    try {
      await db.query('BEGIN');
      await db.query(`SET LOCAL session_replication_role = replica`);
      await db.query(
        `UPDATE market_listings
            SET created_at = now() - interval '29 days',
                expires_at = now() + interval '1 day'
          WHERE id = $1 AND tenant_id = $2`,
        [listingId, c.tenantId],
      );
      await db.query('COMMIT');
    } finally {
      await db.end();
    }
  }

  /** The market's hourly sweep, at the database's clock. */
  const sweep = () => n.sweep(MARKET_LISTINGS_SWEEP, dbClock());

  /** A partner of the compound, listed by its manager (a row, as the schema suites write it). */
  const partner = (c: Compound) =>
    n.inTx(c, (tx) =>
      partnerRow(tx, { tenantId: c.tenantId, createdById: c.managerId }),
    );

  /** A listing's row, as the database holds it. */
  const row = (c: Compound, id: string) =>
    x.asManager(c, () =>
      x.prisma.tenant.marketListing.findUniqueOrThrow({ where: { id } }),
    );

  /**
   * A second owner of a new unit in `building`: not its primary, so they
   * can be erased; with the email an export's step-up needs.
   */
  async function erasable(c: Compound, building: string) {
    const unit = await n.unit(c, building);
    await n.owner(c, unit.id);
    const p = await x.resident(c, [unit.id]);
    return { ...p, ...(await n.who(c, p.id, 'resident')), unitId: unit.id };
  }

  /** The account's personal-data export (ADR 0036), built and read. */
  async function exportOf(who: Who & { email: string }) {
    await stepUp(h, who.token, who.email);
    const asked = await h
      .http()
      .post(`${API}/me/data-exports`)
      .set('Authorization', `Bearer ${who.token}`)
      .send({})
      .expect(201);
    await buildExports(h);
    const dl = await h
      .http()
      .get(
        `${API}/me/data-exports/${(asked.body as { id: string }).id}/download`,
      )
      .set('Authorization', `Bearer ${who.token}`)
      .expect(200);
    return readArchive((dl.body as { url: string }).url);
  }

  return {
    ...n,
    setUp,
    marketSettings,
    listRaw,
    listing,
    review,
    erasable,
    exportOf,
    live,
    market,
    photo,
    expire,
    nearExpiry,
    sweep,
    row,
    partner,
  };
}

export type MarketSetUp = Awaited<
  ReturnType<ReturnType<typeof marketHelpers>['setUp']>
>;
