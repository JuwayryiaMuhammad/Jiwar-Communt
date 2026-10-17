import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { at, day, permitHelpers, type PermitBody } from '../setup/permits';

describe('Permits — furniture moves and material exits (ADR 0049)', () => {
  let h: HttpHarness;
  let p: ReturnType<typeof permitHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness();
    p = permitHelpers(h);
  }, 180_000);

  afterAll(() => h.close());

  const fields = (res: { body: unknown }) =>
    (res.body as { fields?: unknown }).fields;

  describe('moves', () => {
    it('the primary asks: pending, numbered M-, a window of one day; the plate tidied; the management told', async () => {
      const c = await p.setUp('Moves Ask Court');
      await p.anyTime(c.manager);
      const permit = await p.move(c.alice, c.home.id, {
        truckPlate: '  ن  ق ل ٤٥٦ ',
      });
      expect(permit).toMatchObject({
        reference: expect.stringMatching(/^M-\d{4,}$/) as string,
        kind: 'move',
        status: 'pending',
        works: null,
        move: {
          date: day(3),
          window: { from: '10:00', to: '12:00' },
          truckPlate: 'ن ق ل ٤٥٦',
          itemsDescription: 'Two sofas and a fridge',
        },
      });
      expect(new Date(permit.startsAt)).toEqual(at(day(3), 10));
      expect(new Date(permit.endsAt)).toEqual(at(day(3), 12));
      expect(await p.told(c.c, c.manager.id, permit.id)).toEqual([
        { kind: 'unit_permit.requested', params: { permitKind: 'move' } },
      ]);
      const member = await p.family(c.c, c.home.id, c.alice);
      expect(
        p.status(await p.moveRaw(member, c.home.id), 403).body,
      ).toMatchObject({ code: 'PERMIT_NOT_ALLOWED' });
    });

    it('follows the compound’s work days, days off and hours', async () => {
      const c = await p.setUp('Moves Rules Court');
      await p.setRules(c.manager, {
        workDays: [0, 1, 2, 3, 4, 5, 6],
        workHours: { from: '09:00', to: '17:00' },
        daysOff: [day(4)],
      });
      const bad = async (over: Record<string, unknown>) =>
        fields(p.status(await p.moveRaw(c.alice, c.home.id, over), 400));
      expect(await bad({ date: day(4) })).toEqual([
        { field: 'date', code: 'NOT_A_WORK_DAY' },
      ]);
      expect(await bad({ date: day(-1) })).toEqual([
        {
          field: 'date',
          code: 'DAY_OUT_OF_RANGE',
          params: { min: day(0), max: day(90) },
        },
      ]);
      expect(await bad({ window: { from: '08:00', to: '10:00' } })).toEqual([
        {
          field: 'window',
          code: 'OUTSIDE_WORK_HOURS',
          params: { from: '09:00', to: '17:00' },
        },
      ]);
      expect(await bad({ window: { from: '12:00', to: '10:00' } })).toEqual([
        { field: 'window.to', code: 'ENDS_BEFORE_START' },
      ]);
      expect(await bad({ truckPlate: 'TOO LONG A PLATE' })).toEqual([
        {
          field: 'truckPlate',
          code: 'INVALID_FORMAT',
          params: { maxLength: 12 },
        },
      ]);
      // A window of today already over.
      await p.anyTime(c.manager);
      expect(
        await bad({ date: day(0), window: { from: '00:00', to: '00:01' } }),
      ).toEqual([{ field: 'window.to', code: 'INVALID_VALUE' }]);
    });

    it('two live moves per unit', async () => {
      const c = await p.setUp('Moves Limit Court');
      await p.anyTime(c.manager);
      await p.move(c.alice, c.home.id);
      await p.move(c.alice, c.home.id, { date: day(4) });
      expect(
        p.status(await p.moveRaw(c.alice, c.home.id), 409).body,
      ).toMatchObject({
        code: 'PERMIT_LIMIT_REACHED',
        params: { scope: 'move', max: 2 },
      });
    });
  });

  describe('material exits', () => {
    it('the primary asks in advance: items, an optional photo, up to seven days; numbered X-', async () => {
      const c = await p.setUp('Exits Ask Court');
      const photo = await p.files.ready(c.alice.token, 'permit_photo');
      const permit = await p.exit(c.alice, c.home.id, {
        photoFileId: photo,
        items: [{ name: '  Old   tiles ', quantity: 20 }],
      });
      expect(permit).toMatchObject({
        reference: expect.stringMatching(/^X-\d{4,}$/) as string,
        kind: 'material_exit',
        status: 'pending',
        materialExit: {
          validFrom: day(1),
          validUntil: day(3),
          items: [{ name: 'Old tiles', quantity: 20 }],
          photo: { url: expect.any(String) as string },
          usedAt: null,
        },
      });
      expect(new Date(permit.startsAt)).toEqual(at(day(1), 0));
      expect(new Date(permit.endsAt)).toEqual(at(day(4), 0));
      expect(await p.told(c.c, c.manager.id, permit.id)).toEqual([
        {
          kind: 'unit_permit.requested',
          params: { permitKind: 'material_exit' },
        },
      ]);
      // Without a photo, too.
      expect((await p.exit(c.alice, c.home.id)).materialExit).toMatchObject({
        photo: null,
      });
    });

    it('refuses a period too long, no items, too many, and someone else’s photo', async () => {
      const c = await p.setUp('Exits Rules Court');
      const bad = async (over: Record<string, unknown>) =>
        fields(await p.exitRaw(c.alice, c.home.id, over).expect(400));
      expect(await bad({ validFrom: day(1), validUntil: day(8) })).toEqual([
        {
          field: 'validUntil',
          code: 'PERIOD_TOO_LONG',
          params: { maxDays: 7 },
        },
      ]);
      expect(await bad({ validFrom: day(3), validUntil: day(2) })).toEqual([
        { field: 'validUntil', code: 'ENDS_BEFORE_START' },
      ]);
      expect(await bad({ items: [] })).toEqual([
        { field: 'items', code: 'INVALID_LENGTH', params: { min: 1, max: 30 } },
      ]);
      expect(
        await bad({
          items: Array.from({ length: 31 }, () => ({ name: 'x', quantity: 1 })),
        }),
      ).toEqual([
        { field: 'items', code: 'INVALID_LENGTH', params: { min: 1, max: 30 } },
      ]);
      expect(await bad({ items: [{ name: 'x', quantity: 0 }] })).toEqual([
        {
          field: 'items.0.quantity',
          code: 'INVALID_NUMBER',
          params: { min: 1, max: 9999 },
        },
      ]);
      const other = await p.setUp('Exits Other Court');
      const theirs = await p.files.ready(other.alice.token, 'permit_photo');
      expect(await bad({ photoFileId: theirs })).toEqual([
        { field: 'photoFileId', code: 'FILE_NOT_AVAILABLE' },
      ]);
    });

    it('five live per unit; cancelled before it is used', async () => {
      const c = await p.setUp('Exits Limit Court');
      const made: PermitBody[] = [];
      for (let i = 0; i < 5; i += 1)
        made.push(await p.exit(c.alice, c.home.id));
      expect(
        (await p.exitRaw(c.alice, c.home.id).expect(409)).body,
      ).toMatchObject({
        code: 'PERMIT_LIMIT_REACHED',
        params: { scope: 'material_exit', max: 5 },
      });
      await p
        .http('post', `/permits/${made[0].id}/cancel`, c.alice.token, {})
        .expect(200);
      await p.exit(c.alice, c.home.id);
    });
  });
});
