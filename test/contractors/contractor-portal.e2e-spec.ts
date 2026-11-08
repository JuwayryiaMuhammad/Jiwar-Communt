import { err } from '../api/request';
import { dispatchHelpers } from '../setup/dispatch';
import { uniquePhone, uniqueSuffix } from '../setup/fixtures';
import { nationalIdFor } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  type HttpHarness,
} from '../setup/http-app';

type Who = { id: string; token: string };
interface Offer {
  id: string;
  status: string;
  ticketId: string;
  ticketNumber: string;
  categoryKey: string;
  place: string;
  note: string | null;
  takenByMe: boolean;
}

/**
 * ADR 0088: a vendor's contractor accounts, tickets dispatched to a vendor
 * that one of its contractors takes and works through the technician's
 * routes — seeing what a technician on the job sees and nothing more of
 * the compound — and every path by which it loses the ticket letting the
 * vendor go of it too.
 */
describe('The contractor portal: accounts and dispatch to a vendor (ADR 0088)', () => {
  let h: HttpHarness;
  let d: ReturnType<typeof dispatchHelpers>;
  let s: Awaited<ReturnType<ReturnType<typeof dispatchHelpers>['setUp']>>;
  let vendorId: string;
  let otherVendorId: string;
  let ann: Who;
  let bob: Who;
  let eve: Who;

  const http = (
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    token: string,
    body?: object,
  ) => d.http(method, path, token, body);
  const vendor = async () =>
    (
      (
        await http('post', '/staff/vendors', s.manager.token, {
          name: `Fix-It ${uniqueSuffix()}`,
          categories: ['maintenance'],
        }).expect(201)
      ).body as { id: string }
    ).id;
  const contractor = async (vendor: string): Promise<Who> => {
    const res = await http(
      'post',
      `/staff/vendors/${vendor}/contractors`,
      s.manager.token,
      {
        fullName: 'Contractor Person',
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(new Date('1990-05-05')),
        phone: uniquePhone(),
        email: uniqueEmail('contractor'),
      },
    ).expect(201);
    const id = (res.body as { id: string }).id;
    return {
      id,
      token: await h.tokenFor({
        sub: id,
        tid: s.c.tenantId,
        typ: 'contractor',
      }),
    };
  };
  const offer = (ticketId: string, vendor = vendorId, note?: string) =>
    http(
      'post',
      `/maintenance/tickets/${ticketId}/vendor-dispatch`,
      s.supervisor.token,
      { vendorId: vendor, ...(note ? { note } : {}) },
    );
  const offers = async (who: Who, open = true) =>
    (
      (
        await http(
          'get',
          `/contractor/dispatches${open ? '?open=true' : ''}`,
          who.token,
        ).expect(200)
      ).body as { data: Offer[] }
    ).data;
  const dispatches = (ticketId: string) =>
    d.inTenant(s.c, (tx) =>
      tx.ticketVendorDispatch.findMany({
        where: { ticketId },
        orderBy: { offeredAt: 'asc' },
      }),
    );

  beforeAll(async () => {
    h = await createHttpHarness();
    d = dispatchHelpers(h);
    s = await d.setUp(1);
    vendorId = await vendor();
    otherVendorId = await vendor();
    ann = await contractor(vendorId);
    bob = await contractor(vendorId);
    eve = await contractor(otherVendorId);
  }, 240_000);

  afterAll(() => h.close());

  describe('accounts', () => {
    it('a contractor is its own kind, tied to its vendor, with the contractor role', async () => {
      const row = await d.inTenant(s.c, (tx) =>
        tx.account.findUniqueOrThrow({
          where: { id: ann.id },
          include: { role: true },
        }),
      );
      expect(row).toMatchObject({ type: 'contractor', vendorId });
      expect(row.role.key).toBe('contractor');
      const me = await http('get', '/contractor/vendor', ann.token).expect(200);
      expect(me.body).toMatchObject({ id: vendorId, status: 'active' });
      const list = await http(
        'get',
        `/staff/vendors/${vendorId}/contractors`,
        s.manager.token,
      ).expect(200);
      expect(
        (list.body as { data: { id: string }[] }).data.map((a) => a.id),
      ).toEqual(expect.arrayContaining([ann.id, bob.id]));
    });

    it('a contractor’s vendor never changes, and only a contractor has one', async () => {
      await expect(
        d.inTenant(s.c, (tx) =>
          tx.account.update({
            where: { id: ann.id },
            data: { vendorId: otherVendorId },
          }),
        ),
      ).rejects.toThrow(/never changes/);
      await expect(
        d.inTenant(s.c, (tx) =>
          tx.account.update({
            where: { id: s.techs[0].id },
            data: { vendorId },
          }),
        ),
      ).rejects.toThrow(/never changes|accounts_contractor_vendor/);
    });

    it('reaches nothing of the compound a technician’s job does not show', async () => {
      for (const path of [
        '/units',
        '/maintenance/tickets',
        '/accounts',
        '/staff/vendors',
        '/technician/availability',
        '/technician/stats',
      ])
        expect((await http('get', path, ann.token)).status).toBe(403);
      // Nobody can grant it a staff permission: the catalog keeps its kind.
      const roleId = await d.inTenant(
        s.c,
        async (tx) =>
          (await tx.role.findFirstOrThrow({ where: { key: 'contractor' } })).id,
      );
      const res = await http(
        'put',
        `/roles/${roleId}/permissions`,
        s.manager.token,
        {
          permissions: ['tickets.contract_work', 'units.directory'],
        },
      );
      expect(err(res)).toMatchObject({ code: 'PERMISSION_NOT_ASSIGNABLE' });
    });

    it('a suspended vendor takes no new contractor', async () => {
      const v = await vendor();
      await http('post', `/staff/vendors/${v}/suspend`, s.manager.token, {
        reasonCode: 'performance',
      }).expect(200);
      const res = await http(
        'post',
        `/staff/vendors/${v}/contractors`,
        s.manager.token,
        {
          fullName: 'Late Hire',
          idDocumentType: 'national_id',
          idDocumentNumber: nationalIdFor(new Date('1991-01-01')),
          phone: uniquePhone(),
          email: uniqueEmail('late'),
        },
      );
      expect(err(res)).toMatchObject({ status: 409, code: 'VENDOR_SUSPENDED' });
    });
  });

  describe('dispatch to a vendor', () => {
    it('an offered ticket waits for the vendor’s contractors: shown without the unit or a resident, out of dispatch’s hands', async () => {
      const ticketId = await d.openTicket(s);
      const res = await offer(
        ticketId,
        vendorId,
        'Leaking valve, bring a 1/2" key',
      );
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ status: 'offered', vendorId });
      expect((await d.ticketRow(s.c, ticketId)).vendorId).toBe(vendorId);
      const mine = (await offers(ann)).find((o) => o.ticketId === ticketId)!;
      expect(mine).toMatchObject({
        status: 'offered',
        place: 'unit',
        note: 'Leaking valve, bring a 1/2" key',
        takenByMe: false,
      });
      expect(JSON.stringify(mine)).not.toMatch(/Dispatch fixture|unitId/);
      // Another vendor's contractor sees nothing of it.
      expect((await offers(eve)).some((o) => o.ticketId === ticketId)).toBe(
        false,
      );
      expect(
        err(
          await http(
            'post',
            `/contractor/dispatches/${mine.id}/accept`,
            eve.token,
          ),
        ),
      ).toMatchObject({ status: 404, code: 'VENDOR_DISPATCH_NOT_FOUND' });
      // Dispatch takes the offer back before giving it to anyone else.
      expect(
        err(
          await http(
            'post',
            `/maintenance/tickets/${ticketId}/assign`,
            s.supervisor.token,
            {
              technicianId: s.techs[0].id,
            },
          ),
        ),
      ).toMatchObject({ status: 409, code: 'TICKET_OFFERED_TO_VENDOR' });
      expect(err(await offer(ticketId, otherVendorId))).toMatchObject({
        status: 409,
        code: 'TICKET_OFFERED_TO_VENDOR',
      });
    });

    it('a vendor with no contractor who can take it is refused', async () => {
      const ticketId = await d.openTicket(s);
      const empty = await vendor();
      expect(err(await offer(ticketId, empty))).toMatchObject({
        status: 400,
        fields: [{ field: 'vendorId', code: 'INVALID_VALUE' }],
      });
    });

    it('taken: the contractor works it through the technician’s routes; a second taker is told it was taken', async () => {
      const ticketId = await d.openTicket(s);
      const dispatch = (await offer(ticketId).expect(201)).body as {
        id: string;
      };
      const taken = await http(
        'post',
        `/contractor/dispatches/${dispatch.id}/accept`,
        ann.token,
      ).expect(200);
      expect(taken.body).toEqual({ ticketId });
      expect(
        err(
          await http(
            'post',
            `/contractor/dispatches/${dispatch.id}/accept`,
            bob.token,
          ),
        ),
      ).toMatchObject({
        status: 409,
        code: 'VENDOR_DISPATCH_STATE',
        params: { status: 'accepted' },
      });
      const row = await d.ticketRow(s.c, ticketId);
      expect(row).toMatchObject({
        status: 'assigned',
        technicianId: ann.id,
        vendorId,
      });
      // The technician's view of it, and nothing for the other contractor.
      await http('get', `/technician/tickets/${ticketId}`, ann.token).expect(
        200,
      );
      expect(
        (await http('get', `/technician/tickets/${ticketId}`, bob.token))
          .status,
      ).toBe(404);
      await http(
        'post',
        `/technician/tickets/${ticketId}/start`,
        ann.token,
      ).expect(204);
      const list = await http('get', '/technician/tickets', ann.token).expect(
        200,
      );
      expect(
        (list.body as { data: { id: string }[] }).data.map((t) => t.id),
      ).toContain(ticketId);
      const assignment = await d.inTenant(s.c, (tx) =>
        tx.ticketAssignment.findFirstOrThrow({
          where: { ticketId, toId: ann.id },
        }),
      );
      expect(assignment.assignmentType).toBe('vendor');
    });

    it('given back before the work starts: the vendor lets go, the offer is returned', async () => {
      const ticketId = await d.openTicket(s);
      const dispatch = (await offer(ticketId).expect(201)).body as {
        id: string;
      };
      await http(
        'post',
        `/contractor/dispatches/${dispatch.id}/accept`,
        ann.token,
      ).expect(200);
      await http('post', `/technician/tickets/${ticketId}/decline`, ann.token, {
        reasonCode: 'unavailable',
      }).expect(204);
      const after = await d.ticketRow(s.c, ticketId);
      expect(after).toMatchObject({
        status: 'new',
        technicianId: null,
        vendorId: null,
      });
      expect((await dispatches(ticketId)).at(-1)?.status).toBe('returned');
      expect(
        (await http('get', `/technician/tickets/${ticketId}`, ann.token))
          .status,
      ).toBe(404);
    });

    it('turned down by the vendor, or taken back by dispatch, or cancelled: the queue’s again', async () => {
      const t1 = await d.openTicket(s);
      const o1 = (await offer(t1).expect(201)).body as { id: string };
      expect(
        err(
          await http(
            'post',
            `/contractor/dispatches/${o1.id}/decline`,
            bob.token,
            {
              reasonCode: 'nope',
            },
          ),
        ),
      ).toMatchObject({ status: 400, code: 'INVALID_REASON_CODE' });
      await http('post', `/contractor/dispatches/${o1.id}/decline`, bob.token, {
        reasonCode: 'no_capacity',
      }).expect(204);
      expect((await d.ticketRow(s.c, t1)).vendorId).toBeNull();
      expect((await dispatches(t1))[0]).toMatchObject({
        status: 'declined',
        decidedById: bob.id,
        declineReason: 'no_capacity',
      });

      const t2 = await d.openTicket(s);
      await offer(t2).expect(201);
      await http(
        'post',
        `/maintenance/tickets/${t2}/vendor-dispatch/withdraw`,
        s.supervisor.token,
        { reasonCode: 'handled_in_house' },
      ).expect(204);
      expect((await dispatches(t2))[0]).toMatchObject({
        status: 'withdrawn',
        withdrawnById: s.supervisor.id,
      });
      expect((await d.ticketRow(s.c, t2)).vendorId).toBeNull();

      const t3 = await d.openTicket(s);
      await offer(t3).expect(201);
      await http('post', `/tickets/${t3}/cancel`, s.owner.token, {
        reasonCode: 'reporter_request',
      }).expect((r) => expect(r.status).toBeLessThan(300));
      const row = await d.ticketRow(s.c, t3);
      expect(row).toMatchObject({ status: 'cancelled', vendorId: null });
      // Ended by the system, as the ticket was: nobody withdrew it.
      expect((await dispatches(t3))[0]).toMatchObject({
        status: 'withdrawn',
        withdrawnById: null,
      });
    });

    it('a contractor deactivated with a ticket in hand releases it, and the vendor with it', async () => {
      const carl = await contractor(vendorId);
      const ticketId = await d.openTicket(s);
      const o = (await offer(ticketId).expect(201)).body as { id: string };
      await http(
        'post',
        `/contractor/dispatches/${o.id}/accept`,
        carl.token,
      ).expect(200);
      await http('patch', `/accounts/${carl.id}/status`, s.manager.token, {
        status: 'inactive',
      }).expect(200);
      const row = await d.ticketRow(s.c, ticketId);
      expect(row).toMatchObject({
        status: 'new',
        technicianId: null,
        vendorId: null,
      });
      expect((await dispatches(ticketId)).at(-1)?.status).toBe('returned');
    });

    it('two contractors taking one offer at once: one takes it, the other is told (×3)', async () => {
      for (let round = 0; round < 3; round++) {
        const ticketId = await d.openTicket(s);
        const o = (await offer(ticketId).expect(201)).body as { id: string };
        const [x, y] = await Promise.all([
          http('post', `/contractor/dispatches/${o.id}/accept`, ann.token),
          http('post', `/contractor/dispatches/${o.id}/accept`, bob.token),
        ]);
        expect([x.status, y.status].sort()).toEqual([200, 409]);
        const row = await d.ticketRow(s.c, ticketId);
        expect([ann.id, bob.id]).toContain(row.technicianId);
        expect(
          (await dispatches(ticketId)).filter((r) => r.status === 'accepted'),
        ).toHaveLength(1);
      }
    });

    it('a contractor taking an offer as dispatch takes it back: one of the two (×3)', async () => {
      for (let round = 0; round < 3; round++) {
        const ticketId = await d.openTicket(s);
        const o = (await offer(ticketId).expect(201)).body as { id: string };
        const [x, y] = await Promise.all([
          http('post', `/contractor/dispatches/${o.id}/accept`, ann.token),
          http(
            'post',
            `/maintenance/tickets/${ticketId}/vendor-dispatch/withdraw`,
            s.supervisor.token,
            { reasonCode: 'not_needed' },
          ),
        ]);
        const won = x.status === 200 ? 'accepted' : 'withdrawn';
        expect(
          [x.status === 200, y.status === 204].filter(Boolean),
        ).toHaveLength(1);
        expect((await dispatches(ticketId))[0].status).toBe(won);
      }
    });
  });
});
