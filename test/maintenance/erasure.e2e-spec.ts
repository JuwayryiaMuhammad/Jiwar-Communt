import {
  AccountDeletionService,
  scopePhrase,
} from '../../src/core/accounts/account-deletion.service';
import { PlatformModule } from '../../src/core/platform/platform.module';
import { communityHelpers, type Compound } from '../setup/community';
import { fileHelpers } from '../setup/files';
import { gateHelpers } from '../setup/gate';
import { API, createHttpHarness, type HttpHarness } from '../setup/http-app';

/**
 * ADR 0023, 0032: an erasure takes a person's words off their tickets —
 * message bodies nulled with `deleted_at`, the confirmation's comment
 * nulled — and leaves the rest: the sender stays a pointer to the
 * tombstone (rendered `{ id, erased: true }`), the ticket and its photos
 * are the unit's maintenance record and stay whole.
 */
describe('Maintenance — erasure', () => {
  let h: HttpHarness;
  let x: ReturnType<typeof communityHelpers>;

  beforeAll(async () => {
    h = await createHttpHarness({ imports: [PlatformModule] });
    x = communityHelpers(h);
  });

  afterAll(() => h.close());

  const http = (token: string) => ({
    get: (path: string) =>
      h.http().get(`${API}${path}`).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      h
        .http()
        .post(`${API}${path}`)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });
  const token = (
    c: Compound,
    sub: string,
    typ: 'resident' | 'staff' | 'manager',
  ) => h.tokenFor({ sub, tid: c.tenantId, typ });

  it('nulls the person’s messages and comment; keeps the ticket, its photos and the pointer', async () => {
    const c = await x.compound('Erased Tickets');
    const unit = await x.unit(c);
    await x.resident(c, [unit.id]);
    const leaving = await x.resident(c, [unit.id]);
    const tech = await gateHelpers(h).guard(c, 'technician');
    const me = http(await token(c, leaving.id, 'resident'));
    const technician = http(await token(c, tech.id, 'staff'));
    const manager = http(await token(c, c.managerId, 'manager'));
    const category = await x.asManager(c, () =>
      x.prisma.tenant.ticketCategory.findFirstOrThrow({
        where: { key: 'plumbing' },
      }),
    );
    const photo = await fileHelpers(h).ready(
      await token(c, leaving.id, 'resident'),
      'ticket_photo',
    );
    const ticket = (
      await me
        .post('/tickets', {
          unitId: unit.id,
          categoryId: category.id,
          description: 'Leak in the kitchen',
          photoFileIds: [photo],
        })
        .expect(201)
    ).body as { id: string };
    await me
      .post(`/tickets/${ticket.id}/messages`, { body: 'ERASE-ME message' })
      .expect(201);
    await manager
      .post(`/maintenance/tickets/${ticket.id}/assign`, {
        technicianId: tech.id,
      })
      .expect(204);
    await technician
      .post(`/technician/tickets/${ticket.id}/messages`, { body: 'On my way' })
      .expect(201);
    await technician.post(`/technician/tickets/${ticket.id}/start`).expect(204);
    await technician
      .post(`/technician/tickets/${ticket.id}/complete`)
      .expect(204);
    await me
      .post(`/tickets/${ticket.id}/confirm`, {
        rating: 5,
        comment: 'ERASE-ME comment',
      })
      .expect(204);

    // The three steps of ADR 0023, past the grace period.
    const deletion = h.moduleRef.get(AccountDeletionService);
    const request = await x.as(c, { id: leaving.id, type: 'resident' }, () =>
      deletion.requestDeletion('DELETE'),
    );
    await x.asManager(c, () =>
      x.prisma.tenant.accountDeletionRequest.update({
        where: { id: request.id },
        data: {
          requestedAt: new Date(Date.now() - 31 * 86_400_000),
          effectiveAt: new Date(Date.now() - 86_400_000),
        },
      }),
    );
    await x.asManager(c, () =>
      deletion.erase(request.id, scopePhrase(leaving.id)),
    );

    const [messages, feedback, row, file] = await x.asManager(c, () =>
      Promise.all([
        x.prisma.tenant.ticketMessage.findMany({
          where: { ticketId: ticket.id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
        x.prisma.tenant.ticketFeedback.findMany({
          where: { ticketId: ticket.id },
        }),
        x.prisma.tenant.ticket.findUniqueOrThrow({ where: { id: ticket.id } }),
        x.prisma.tenant.storedFile.findUniqueOrThrow({ where: { id: photo } }),
      ]),
    );
    expect(messages).toMatchObject([
      { senderId: leaving.id, body: null, deletedAt: expect.any(Date) as Date },
      { senderId: tech.id, body: 'On my way', deletedAt: null },
    ]);
    expect(feedback).toMatchObject([
      { authorId: leaving.id, rating: 5, comment: null },
    ]);
    expect(row).toMatchObject({
      reporterId: leaving.id,
      createdById: leaving.id,
      description: 'Leak in the kitchen',
      status: 'closed',
    });
    expect(file.deletedAt).toBeNull();

    // Views: the tombstone, never a name; the photo still reads.
    const thread = await manager
      .get(`/maintenance/tickets/${ticket.id}/messages`)
      .expect(200);
    expect(thread.body).toMatchObject({
      data: [
        {
          sender: { id: leaving.id, erased: true },
          body: null,
          deleted: true,
        },
        { sender: { id: tech.id }, body: 'On my way', deleted: false },
      ],
    });
    const detail = await manager
      .get(`/maintenance/tickets/${ticket.id}`)
      .expect(200);
    expect(detail.body).toMatchObject({
      reporter: { id: leaving.id, erased: true },
      createdBy: { id: leaving.id, erased: true },
      feedback: [{ comment: null, author: { id: leaving.id, erased: true } }],
      photos: [{ kind: 'report', url: expect.any(String) as string }],
    });
    const techView = await technician
      .get(`/technician/tickets/${ticket.id}/messages`)
      .expect(200);
    expect(JSON.stringify(techView.body)).not.toContain('ERASE-ME');
    expect(techView.body).toMatchObject({
      data: [{ sender: { erased: true }, mine: false }, { mine: true }],
    });
  });
});
