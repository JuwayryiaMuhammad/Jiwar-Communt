import { AccountsService } from '../../src/core/accounts/accounts.service';
import { eraseNow } from '../setup/erasure';
import { buildExports, readArchive, stepUp } from '../setup/exports';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';
import {
  at,
  day,
  facilitiesHelpers,
  type FacilitiesSetUp,
  type Who,
} from '../setup/facilities';

/**
 * ADR 0044 with ADR 0023 and 0036: what a personal-data export holds of
 * bookings and the club, and what becomes of a booker's bookings when
 * they are erased, deactivated or leave.
 */
describe('Facilities — export, erasure, deactivation and leaving', () => {
  let h: HttpHarness;
  let f: ReturnType<typeof facilitiesHelpers>;
  let s: FacilitiesSetUp;
  let court: string;

  beforeAll(async () => {
    h = await createHttpHarness();
    f = facilitiesHelpers(h);
    s = await f.setUp();
    court = await f.facility(s.c, s.manager, { capacity: 10, weeklyQuota: 20 });
  }, 180_000);

  afterAll(() => h.close());

  /** A second owner who lives in the unit: not its primary, so they can go. */
  async function resident(unitId: string) {
    const p = await f.x.resident(s.c, [unitId]);
    return { ...p, ...(await f.who(s.c, p.id, 'resident')) };
  }

  async function exportOf(p: Who & { email: string }) {
    await stepUp(h, p.token, p.email);
    const asked = await h
      .http()
      .post(`${API}/me/data-exports`)
      .set('Authorization', `Bearer ${p.token}`)
      .send({})
      .expect(201);
    await buildExports(h);
    const dl = await h
      .http()
      .get(
        `${API}/me/data-exports/${(asked.body as { id: string }).id}/download`,
      )
      .set('Authorization', `Bearer ${p.token}`)
      .expect(200);
    return readArchive((dl.body as { url: string }).url);
  }

  it('the export holds the account’s own bookings and, per unit, its club membership as it sees it — nobody else’s name', async () => {
    const home = await f.unit(s.c, 'P');
    const primary = await f.owner(s.c, home.id);
    const p = await resident(home.id);
    const mine = [
      await f.book(p, home.id, court, at(day(2), 10)),
      await f.book(p, home.id, court, at(day(3), 10)),
    ];
    await f.book(primary, home.id, court, at(day(2), 11));
    const accountant = await f.accountant(s.c);
    const plan = await f.plan(s.c, s.manager);
    const membership = await f.membership(s.c, accountant, home.id);
    await f.pay(accountant, membership, plan).expect(201);

    const archive = await exportOf(p);
    const section = archive.names.filter((x) => x.startsWith('facilities/'));
    expect(section.sort()).toEqual([
      'facilities/bookings.json',
      `facilities/club/${home.code}.json`,
    ]);
    const bookings = JSON.parse(archive.text('facilities/bookings.json')) as {
      id: string;
      mine: boolean;
    }[];
    expect(bookings.map((b) => b.id).sort()).toEqual(
      mine.map((b) => b.id).sort(),
    );
    expect(bookings.every((b) => b.mine)).toBe(true);
    const club = JSON.parse(
      archive.text(`facilities/club/${home.code}.json`),
    ) as {
      state: string;
      coversMeSince: string | null;
      payments: unknown[] | null;
    };
    expect(club.state).toBe('active');
    expect(club.coversMeSince).not.toBeNull();
    expect(club.payments).toHaveLength(1);
    const text = section.map(archive.text).join('\n');
    const primaryRow = await f.inTx(s.c, (tx) =>
      tx.account.findUniqueOrThrow({ where: { id: primary.id } }),
    );
    expect(text).not.toContain(primaryRow.fullName!);
    expect(text).not.toContain(primary.id);
  });

  it('erased: the booker’s bookings that have not started are cancelled by the system (`booker_left`: an erasure deactivates first) and free their places; every row stays, with the tombstone', async () => {
    const home = await f.unit(s.c, 'P');
    await f.owner(s.c, home.id);
    const p = await resident(home.id);
    const ahead = await f.book(p, home.id, court, at(day(4), 10));
    const past = await f.rawBooking(s.c, {
      facilityId: court,
      unitId: home.id,
      bookedById: p.id,
      startsAt: new Date(Date.now() - 2 * 3_600_000),
    });
    await eraseNow(h, s.c, p.id);
    expect(await f.row(s.c, ahead.id)).toMatchObject({
      status: 'cancelled',
      cancelledSide: 'system',
      cancelReason: 'booker_left',
      bookedById: p.id,
    });
    expect((await f.row(s.c, past)).status).toBe('confirmed');
    const staff = (
      await f
        .http('get', `/staff/bookings/${ahead.id}`, s.handler.token)
        .expect(200)
    ).body as { bookedBy: { fullName: string | null; erased: boolean } };
    expect(staff.bookedBy).toEqual({ id: p.id, fullName: null, erased: true });
    // Nobody is told: the booker is gone.
    expect(await f.notifications(s.c, p.id)).toEqual([]);
  });

  it('deactivated: the same, `booker_left`', async () => {
    const home = await f.unit(s.c, 'P');
    await f.owner(s.c, home.id);
    const p = await resident(home.id);
    const ahead = await f.book(p, home.id, court, at(day(4), 11));
    await f.x.asManager(s.c, () =>
      h.moduleRef
        .get(AccountsService)
        .updateStatus(p.id, { status: 'inactive' }),
    );
    expect(await f.row(s.c, ahead.id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'booker_left',
    });
  });

  it('leaving the unit: what was booked there and has not started is cancelled; another unit’s bookings stay', async () => {
    const home = await f.unit(s.c, 'P');
    const other = await f.unit(s.c, 'P');
    await f.owner(s.c, home.id);
    await f.owner(s.c, other.id);
    const created = await f.x.resident(s.c, [home.id, other.id]);
    const p = await f.who(s.c, created.id, 'resident');
    const here = await f.book(p, home.id, court, at(day(5), 10));
    const there = await f.book(p, other.id, court, at(day(5), 11));
    const occupancies = await f.x.occupancies(s.c, home.id);
    const mine = occupancies.find(
      (o) => o.accountId === p.id && o.status === 'active',
    )!;
    await f.x.asManager(s.c, () =>
      f.x.residents.endOccupancy(mine.id, {
        code: 'moved_out',
        text: 'Moved out',
      }),
    );
    expect(await f.row(s.c, here.id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'booker_left',
    });
    expect((await f.row(s.c, there.id)).status).toBe('confirmed');
  });

  it('a member who loses `bookings` keeps what they booked, and books no more', async () => {
    const home = await f.unit(s.c, 'P');
    const primary = await f.owner(s.c, home.id);
    const member = await f.family(s.c, home.id, primary);
    const kept = await f.book(member, home.id, court, at(day(6), 10));
    await f.revokeBookings(s.c, primary, member.memberId);
    expect((await f.row(s.c, kept.id)).status).toBe('confirmed');
    const refused = await f.bookRaw(member, home.id, court, at(day(6), 11));
    expect(refused.status).toBe(403);
  });
});
