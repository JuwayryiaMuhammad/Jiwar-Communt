import { newId } from '../../src/core/common/uuid';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { communityHelpers } from '../setup/community';
import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { auditReaders } from '../setup/audit';
import { MOVED_OUT } from '../setup/fixtures';

/** Primary resident per unit and the household-review flag (ADR 0016). */
describe('Primary resident', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;
  let read: ReturnType<typeof auditReaders>;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
    read = auditReaders(h);
  });

  afterAll(() => h.close());

  const primaries = async (
    c: Awaited<ReturnType<typeof x.compound>>,
    unitId: string,
  ) =>
    (await x.occupancies(c, unitId))
      .filter((o) => o.status === 'active' && o.isPrimary)
      .map((o) => o.accountId);

  it('the first active occupant of a unit becomes primary; later ones do not', async () => {
    const c = await x.compound();
    const u1 = await x.unit(c);
    const u2 = await x.unit(c);
    const first = await x.resident(c, [u1.id, u2.id]);
    const second = await x.resident(c, [u1.id], 'tenant');

    expect(await primaries(c, u1.id)).toEqual([first.id]);
    expect(await primaries(c, u2.id)).toEqual([first.id]);
    const view = await x.asManager(c, () => x.residents.get(second.id));
    expect(view.occupancies[0].isPrimary).toBe(false);

    // addOccupancy on a vacant unit makes the newcomer primary.
    const u3 = await x.unit(c);
    const added = await x.asManager(c, () =>
      x.residents.addOccupancy(second.id, {
        unitId: u3.id,
        occupancyType: 'tenant',
      }),
    );
    expect(added.isPrimary).toBe(true);
  });

  it('concurrent first occupants of one unit: exactly one primary (unit row lock)', async () => {
    const c = await x.compound();
    const u = await x.unit(c);
    const created = await Promise.all(
      Array.from({ length: 5 }, () => x.resident(c, [u.id])),
    );
    expect(created).toHaveLength(5);
    expect(await primaries(c, u.id)).toHaveLength(1);
  });

  it("ending the primary's occupancy flags the unit, promotes no one and leaves the household alone", async () => {
    const c = await x.compound();
    const u = await x.unit(c);
    const primary = await x.resident(c, [u.id]);
    const other = await x.resident(c, [u.id], 'tenant');

    // A household member row, written directly (the household service
    // arrives later): it must survive the primary leaving untouched.
    const memberId = newId();
    await x.asManager(c, () =>
      x.prisma.tenant.householdMember.create({
        data: {
          id: memberId,
          tenantId: c.tenantId,
          unitId: u.id,
          relation: 'child',
          isMinor: true,
          fullName: 'Kid',
          idDocumentNumber: '31501010100011',
          idDocumentType: 'national_id' as const,
          nationality: 'EG',
          birthDate: new Date('2015-01-01'),
          status: 'active',
          addedById: primary.id,
        },
      }),
    );
    const before = await x.asManager(c, () =>
      x.prisma.tenant.householdMember.findUniqueOrThrow({
        where: { id: memberId },
      }),
    );

    const occupancy = (await x.occupancies(c, u.id)).find(
      (o) => o.accountId === primary.id,
    )!;
    await x.asManager(c, () =>
      x.residents.endOccupancy(occupancy.id, MOVED_OUT),
    );

    const unit = await x.unitRow(c, u.id);
    expect(unit.needsHouseholdReview).toBe(true);
    expect(unit.householdReviewReason).toBe('primary_left');
    expect(await primaries(c, u.id)).toEqual([]);
    expect(
      (await x.occupancies(c, u.id)).find((o) => o.accountId === other.id)
        ?.isPrimary,
    ).toBe(false);
    expect(
      await x.asManager(c, () =>
        x.prisma.tenant.householdMember.findUniqueOrThrow({
          where: { id: memberId },
        }),
      ),
    ).toEqual(before);

    const [flag] = await read.tenant(c.tenantId, {
      action: 'unit.household_review_flagged',
      targetId: u.id,
    });
    expect(flag.metadata).toEqual({
      reason: 'primary_left',
      occupancyId: occupancy.id,
    });
  });

  it('ending a non-primary occupancy flags nothing', async () => {
    const c = await x.compound();
    const u = await x.unit(c);
    await x.resident(c, [u.id]);
    const other = await x.resident(c, [u.id], 'tenant');
    const occupancy = (await x.occupancies(c, u.id)).find(
      (o) => o.accountId === other.id,
    )!;
    await x.asManager(c, () =>
      x.residents.endOccupancy(occupancy.id, MOVED_OUT),
    );
    expect((await x.unitRow(c, u.id)).needsHouseholdReview).toBe(false);
  });

  it('setPrimary swaps the primary, clears the flag, and is audited with the previous one', async () => {
    const c = await x.compound();
    const u = await x.unit(c);
    const first = await x.resident(c, [u.id]);
    const second = await x.resident(c, [u.id], 'tenant');

    const view = await x.asManager(c, () =>
      x.residents.setPrimary(u.id, second.id),
    );
    expect(view.isPrimary).toBe(true);
    expect(await primaries(c, u.id)).toEqual([second.id]);

    const [entry] = await read.tenant(c.tenantId, {
      action: 'occupancy.primary_changed',
      targetId: view.id,
    });
    const previous = (await x.occupancies(c, u.id)).find(
      (o) => o.accountId === first.id,
    )!;
    expect(entry.metadata).toEqual({
      unitId: u.id,
      accountId: second.id,
      previousOccupancyId: previous.id,
      previousAccountId: first.id,
    });

    // The primary leaves; a new primary clears the flag.
    await x.asManager(c, () => x.residents.endOccupancy(view.id, MOVED_OUT));
    expect((await x.unitRow(c, u.id)).needsHouseholdReview).toBe(true);
    await x.asManager(c, () => x.residents.setPrimary(u.id, first.id));
    const unit = await x.unitRow(c, u.id);
    expect(unit.needsHouseholdReview).toBe(false);
    expect(unit.householdReviewReason).toBeNull();
  });

  it('setPrimary needs an active occupancy on that unit, in this compound', async () => {
    const c = await x.compound();
    const other = await x.compound();
    const u = await x.unit(c);
    const elsewhere = await x.unit(c);
    const outsider = await x.resident(c, [elsewhere.id]);
    await x.resident(c, [u.id]);

    await expect(
      x.asManager(c, () => x.residents.setPrimary(u.id, outsider.id)),
    ).rejects.toMatchObject({
      response: { code: 'OCCUPANCY_NOT_FOUND' },
    });
    // A unit of another compound does not exist from here.
    await expect(
      x.asManager(other, () => x.residents.setPrimary(u.id, outsider.id)),
    ).rejects.toMatchObject({ response: { code: 'UNIT_NOT_FOUND' } });
  });

  describe('units needing review', () => {
    async function flagged(c: Awaited<ReturnType<typeof x.compound>>) {
      const u = await x.unit(c);
      const primary = await x.resident(c, [u.id]);
      await x.resident(c, [u.id], 'tenant');
      const occupancy = (await x.occupancies(c, u.id)).find(
        (o) => o.accountId === primary.id,
      )!;
      await x.asManager(c, () =>
        x.residents.endOccupancy(occupancy.id, MOVED_OUT),
      );
      return u;
    }

    it('lists a flagged unit with its reason and occupants; setting a primary removes it', async () => {
      const c = await x.compound();
      const u = await flagged(c);
      await x.unit(c); // an unflagged unit stays out
      const page = await x.asManager(c, () => x.residents.unitsNeedingReview());
      expect(page.items).toEqual([
        {
          unitId: u.id,
          code: u.code,
          reason: 'primary_left',
          flaggedAt: expect.any(Date) as unknown,
          activeOccupants: 1,
        },
      ]);
      expect(page.nextCursor).toBeNull();

      const remaining = (await x.occupancies(c, u.id)).find(
        (o) => o.status === 'active',
      )!;
      await x.asManager(c, () =>
        x.residents.setPrimary(u.id, remaining.accountId),
      );
      expect(
        (await x.asManager(c, () => x.residents.unitsNeedingReview())).items,
      ).toEqual([]);
    });

    it('pages newest first without gaps or duplicates; a bad cursor is a field error', async () => {
      const c = await x.compound();
      const units = [];
      for (let i = 0; i < 3; i++) units.push(await flagged(c));
      const first = await x.asManager(c, () =>
        x.residents.unitsNeedingReview({ limit: 2 }),
      );
      expect(first.items).toHaveLength(2);
      const second = await x.asManager(c, () =>
        x.residents.unitsNeedingReview({ limit: 2, cursor: first.nextCursor! }),
      );
      expect(second.nextCursor).toBeNull();
      const seen = [...first.items, ...second.items].map((i) => i.unitId);
      expect(seen).toEqual(units.map((u) => u.id).reverse());

      await expect(
        x.asManager(c, () =>
          x.residents.unitsNeedingReview({ cursor: 'not-a-cursor' }),
        ),
      ).rejects.toMatchObject({
        response: { fields: [{ field: 'cursor', code: 'INVALID_FORMAT' }] },
      });
    });

    it("tenant B never sees tenant A's units", async () => {
      const a = await x.compound();
      const b = await x.compound();
      await flagged(a);
      expect(
        (await x.asManager(b, () => x.residents.unitsNeedingReview())).items,
      ).toEqual([]);
    });
  });
});
