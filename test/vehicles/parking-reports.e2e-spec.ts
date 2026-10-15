import { createHttpHarness, type HttpHarness } from '../setup/http-app';
import { newId } from '../../src/core/common/uuid';
import { auditReaders } from '../setup/audit';
import { day, vehicleHelpers, type Who } from '../setup/vehicles';

interface MyReport {
  id: string;
  reference: string;
  plate: string;
  location: string;
  note: string | null;
  status: string;
  createdAt: string;
}

/**
 * ADR 0045: a resident reports a wrongly parked vehicle — a plate, never a
 * unit — and learns nothing of whom it matches. Security sees the reporter
 * and the matches, closes the report or turns it into a fine; the fine
 * carries nothing of the report, so the reported unit never learns who
 * reported.
 */
describe('Parking reports', () => {
  let h: HttpHarness;
  let v: ReturnType<typeof vehicleHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof vehicleHelpers>['setUp']>>;
  let security: Who;

  beforeAll(async () => {
    h = await createHttpHarness();
    v = vehicleHelpers(h);
    s = await v.setUp();
    await v
      .http('patch', '/staff/vehicle-settings', s.manager.token, {
        maxVehiclesPerUnit: 20,
      })
      .expect(200);
    security = await v.staff(s.c, ['parking_reports.handle', 'fines.issue']);
  }, 120_000);

  afterAll(() => h.close());

  const report = (
    who: Who,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) => v.http('post', '/parking-reports', who.token, body, headers);
  const outcome = (res: { status: number; body: unknown }) => ({
    status: res.status,
    code: (res.body as { code?: string }).code,
  });
  const fullName = async (id: string) =>
    (await v.inTx(s.c, (tx) => tx.account.findUniqueOrThrow({ where: { id } })))
      .fullName!;

  async function reported() {
    const home = await v.unit(s.c);
    const owner = await v.owner(s.c, home.id);
    const member = await v.family(s.c, home.id, owner);
    const car = await v.register(member, home.id, {
      plate: `RPT ${Math.floor(Math.random() * 9000) + 1000}`,
    });
    return { home, owner, member, car };
  }

  describe('the reporter', () => {
    it('reports a plate; the answer is the same whether it matches anything or not', async () => {
      const target = await reported();
      const reporterHome = await v.unit(s.c);
      const reporter = await v.owner(s.c, reporterHome.id);
      const matching = await report(reporter, {
        plate: target.car.plate.toLowerCase(),
        location: ' Visitor area B ',
        note: 'Blocking two spaces',
      }).expect(201);
      const nothing = await report(reporter, {
        plate: 'NONE 404',
        location: 'Visitor area B',
      }).expect(201);
      for (const res of [matching, nothing]) {
        expect(res.headers['cache-control']).toBe('no-store');
        expect(Object.keys(res.body as object).sort()).toEqual(
          [
            'createdAt',
            'id',
            'location',
            'note',
            'plate',
            'reference',
            'status',
          ].sort(),
        );
        expect((res.body as MyReport).status).toBe('open');
        expect((res.body as MyReport).reference).toMatch(/^R-\d{4,}$/);
      }
      expect(matching.body).toMatchObject({
        plate: target.car.plate,
        location: 'Visitor area B',
      });
      const text = JSON.stringify(matching.body);
      expect(text).not.toContain(target.home.code);
      expect(text).not.toContain(target.home.id);
      expect(text).not.toContain(target.car.id);
    });

    it('lists their own reports, open or closed — never the outcome, never another’s', async () => {
      const homeA = await v.unit(s.c);
      const a = await v.owner(s.c, homeA.id);
      const homeB = await v.unit(s.c);
      const b = await v.owner(s.c, homeB.id);
      const target = await reported();
      const mine = (
        await report(a, { plate: target.car.plate, location: 'Gate 2' }).expect(
          201,
        )
      ).body as MyReport;
      await report(b, { plate: 'OTHER 1', location: 'Gate 2' }).expect(201);
      await v
        .http(
          'post',
          `/staff/parking-reports/${mine.id}/convert`,
          security.token,
          {
            unitCode: target.home.code,
            vehicleId: target.car.id,
            reason: 'blocking',
            amount: '200',
            occurredOn: day(0),
          },
        )
        .expect(200);
      const list = (
        (await v.http('get', '/parking-reports', a.token).expect(200)).body as {
          data: MyReport[];
        }
      ).data;
      expect(list.map((r) => r.id)).toEqual([mine.id]);
      expect(list[0].status).toBe('closed');
      expect(JSON.stringify(list)).not.toContain(target.home.code);
    });

    it('refuses a plate that is not one; at most ten open per resident', async () => {
      const home = await v.unit(s.c);
      const someone = await v.owner(s.c, home.id);
      expect(
        (await report(someone, { plate: 'AB-12', location: 'Here' })).body,
      ).toMatchObject({
        fields: [
          { field: 'plate', code: 'INVALID_FORMAT', params: { maxLength: 12 } },
        ],
      });
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          report(someone, { plate: `LIM ${1000 + i}`, location: 'Here' }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(10);
      expect(
        results
          .filter((r) => r.status !== 201)
          .map((r) => r.body as { code: string; params: object }),
      ).toEqual([
        expect.objectContaining({
          code: 'PARKING_REPORT_LIMIT_REACHED',
          params: { max: 10 },
        }),
        expect.objectContaining({
          code: 'PARKING_REPORT_LIMIT_REACHED',
          params: { max: 10 },
        }),
      ]);
    });

    it('the same Idempotency-Key twice at once files one report', async () => {
      const home = await v.unit(s.c);
      const someone = await v.owner(s.c, home.id);
      const key = newId();
      const body = { plate: 'IDEM 1', location: 'Here' };
      await Promise.all([
        report(someone, body, { 'Idempotency-Key': key }),
        report(someone, body, { 'Idempotency-Key': key }),
      ]);
      expect(
        await v.inTx(s.c, (tx) =>
          tx.parkingReport.count({ where: { reporterId: someone.id } }),
        ),
      ).toBe(1);
    });
  });

  describe('security', () => {
    it('sees the reporter, the photo and the plate’s matches; the queue is oldest first', async () => {
      const target = await reported();
      const home = await v.unit(s.c);
      const reporter = await v.owner(s.c, home.id);
      const photo = await v.files.ready(reporter.token, 'parking_photo');
      const first = (
        await report(reporter, {
          plate: target.car.plate,
          location: 'Fire lane',
          photoFileId: photo,
        }).expect(201)
      ).body as MyReport;
      const second = (
        await report(reporter, {
          plate: 'NONE 1',
          location: 'Fire lane',
        }).expect(201)
      ).body as MyReport;
      const detail = (
        await v
          .http('get', `/staff/parking-reports/${first.id}`, security.token)
          .expect(200)
      ).body as Record<string, unknown>;
      expect(detail).toMatchObject({
        reporter: { id: reporter.id, fullName: await fullName(reporter.id) },
        photoUrl: expect.stringContaining('http') as string,
        status: 'open',
        matches: [
          {
            vehicleId: target.car.id,
            unitId: target.home.id,
            unitCode: target.home.code,
            permitStatus: 'pending',
          },
        ],
      });
      const queue = (
        (
          await v
            .http('get', '/staff/parking-reports?status=open', security.token)
            .expect(200)
        ).body as { data: { id: string }[] }
      ).data.map((r) => r.id);
      expect(queue.indexOf(first.id)).toBeLessThan(queue.indexOf(second.id));
    });

    it('closes a report once, with a reason code', async () => {
      const home = await v.unit(s.c);
      const reporter = await v.owner(s.c, home.id);
      const r = (
        await report(reporter, { plate: 'CLOSE 1', location: 'Here' }).expect(
          201,
        )
      ).body as MyReport;
      await v
        .http('post', `/staff/parking-reports/${r.id}/close`, security.token, {
          reasonCode: 'vehicle_not_found',
        })
        .expect(200)
        .expect((res) =>
          expect(res.body).toMatchObject({
            status: 'closed',
            closeReason: 'vehicle_not_found',
            handledBy: { id: security.id },
          }),
        );
      expect(
        outcome(
          await v.http(
            'post',
            `/staff/parking-reports/${r.id}/close`,
            security.token,
            {
              reasonCode: 'duplicate',
            },
          ),
        ),
      ).toEqual({ status: 409, code: 'PARKING_REPORT_CLOSED' });
    });

    it('converting needs fines.issue too', async () => {
      const handlerOnly = await v.staff(s.c, ['parking_reports.handle']);
      const home = await v.unit(s.c);
      const reporter = await v.owner(s.c, home.id);
      const r = (
        await report(reporter, { plate: 'CONV 1', location: 'Here' }).expect(
          201,
        )
      ).body as MyReport;
      expect(
        outcome(
          await v.http(
            'post',
            `/staff/parking-reports/${r.id}/convert`,
            handlerOnly.token,
            {
              unitCode: home.code,
              plate: 'CONV 1',
              reason: 'blocking',
              amount: '100',
              occurredOn: day(0),
            },
          ),
        ),
      ).toEqual({ status: 403, code: 'FORBIDDEN' });
    });
  });

  describe('the reported unit never learns who reported', () => {
    it('a converted fine is key for key a direct fine, without the reporter or the report’s photo', async () => {
      const target = await reported();
      const home = await v.unit(s.c);
      const reporter = await v.owner(s.c, home.id);
      const photo = await v.files.ready(reporter.token, 'parking_photo');
      const r = (
        await report(reporter, {
          plate: target.car.plate,
          location: 'Fire lane by block C',
          note: 'Seen at 9am',
          photoFileId: photo,
        }).expect(201)
      ).body as MyReport;
      const converted = (
        await v
          .http(
            'post',
            `/staff/parking-reports/${r.id}/convert`,
            security.token,
            {
              unitCode: target.home.code,
              vehicleId: target.car.id,
              reason: 'fire_lane',
              amount: '400',
              occurredOn: day(0),
            },
          )
          .expect(200)
      ).body as { status: string; fineId: string };
      expect(converted.status).toBe('converted');
      const direct = await v.fine(security, target.home.code, {
        vehicleId: target.car.id,
        plate: undefined,
        reason: 'fire_lane',
        amount: '400',
      });
      const read = async (who: Who, id: string) =>
        (await v.http('get', `/vehicle-fines/${id}`, who.token).expect(200))
          .body as Record<string, unknown>;
      for (const who of [target.owner, target.member]) {
        const fromReport = await read(who, converted.fineId);
        const issued = await read(who, direct.id);
        expect(Object.keys(fromReport).sort()).toEqual(
          Object.keys(issued).sort(),
        );
        const strip = (f: Record<string, unknown>) => {
          const { id: _id, reference: _ref, createdAt: _at, ...rest } = f;
          void _id;
          void _ref;
          void _at;
          return rest;
        };
        expect(strip(fromReport)).toEqual(strip(issued));
        expect(fromReport.photoUrl).toBeNull();
        const text = JSON.stringify(fromReport);
        expect(text).not.toContain(reporter.id);
        expect(text).not.toContain(await fullName(reporter.id));
        expect(text).not.toContain(r.id);
        expect(text).not.toContain('Seen at 9am');
        expect(text).not.toContain('Fire lane by block C');
      }
      // The unit's list and the notifications are the same for both.
      const list = (
        (
          await v
            .http(
              'get',
              `/units/${target.home.id}/vehicle-fines`,
              target.owner.token,
            )
            .expect(200)
        ).body as { data: unknown[] }
      ).data;
      expect(JSON.stringify(list)).not.toContain(reporter.id);
      const told = await v.notifications(
        s.c,
        target.owner.id,
        'vehicle_fine.issued',
      );
      const params = told
        .filter((n) => [converted.fineId, direct.id].includes(n.targetId!))
        .map((n) => n.params);
      expect(params).toEqual([
        { reason: 'fire_lane' },
        { reason: 'fire_lane' },
      ]);
      // The fine row itself carries no link to the report.
      const row = await v.inTx(s.c, (tx) =>
        tx.vehicleFine.findUniqueOrThrow({ where: { id: converted.fineId } }),
      );
      expect(JSON.stringify(row)).not.toContain(r.id);
      expect(row.photoFileId).toBeNull();
    });

    it('the audit rows of the fine name the issuer only; the report’s audit is the reporter’s', async () => {
      const target = await reported();
      const home = await v.unit(s.c);
      const reporter = await v.owner(s.c, home.id);
      const r = (
        await report(reporter, {
          plate: target.car.plate,
          location: 'Ramp',
        }).expect(201)
      ).body as MyReport;
      const converted = (
        await v
          .http(
            'post',
            `/staff/parking-reports/${r.id}/convert`,
            security.token,
            {
              unitCode: target.home.code,
              vehicleId: target.car.id,
              reason: 'blocking',
              amount: '100',
              occurredOn: day(0),
            },
          )
          .expect(200)
      ).body as { fineId: string };
      const fineRows = await auditReaders(h).tenant(s.c.tenantId, {
        targetId: converted.fineId,
      });
      expect(fineRows.map((x) => x.actorId)).toEqual([security.id]);
      expect(JSON.stringify(fineRows)).not.toContain(reporter.id);
      expect(JSON.stringify(fineRows)).not.toContain(r.id);
    });
  });
});
