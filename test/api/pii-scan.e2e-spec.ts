import { HouseholdsService } from '../../src/community/households/households.service';
import { RegistrationService } from '../../src/community/residents/registration.service';
import { WorkersService } from '../../src/community/workers/workers.service';
import { RolesService } from '../../src/core/access/roles.service';
import { AccountDeletionService } from '../../src/core/accounts/account-deletion.service';
import { ParcelTokens } from '../../src/gate/parcels/parcel-tokens';
import { VisitorPassesService } from '../../src/gate/visitors/visitor-passes.service';
import { ApprovalsService } from '../../src/gate/approvals/approvals.service';
import { AvailabilityService } from '../../src/maintenance/dispatch/availability.service';
import { SpecialtiesService } from '../../src/maintenance/specialties/specialties.service';
import { ConfirmationService } from '../../src/maintenance/tickets/confirmation.service';
import { DispatchService } from '../../src/maintenance/tickets/dispatch.service';
import { MessagesService } from '../../src/maintenance/tickets/messages.service';
import { TicketsService } from '../../src/maintenance/tickets/tickets.service';
import { WorkService } from '../../src/maintenance/tickets/work.service';
import { VisitConsentService } from '../../src/maintenance/visits/visit-consent.service';
import { VisitsService } from '../../src/maintenance/visits/visits.service';
import { gateHelpers } from '../setup/gate';
import { parcelHelpers } from '../setup/parcels';
import { fileHelpers } from '../setup/files';
import { nationalIdFor, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { fill, paramNames, call } from './request';
import { ROUTES } from './routes';
import { buildWorld, type World } from './world';

const born = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m - 1, d));
const iso = (d: Date) => d.toISOString().slice(0, 10);

interface Someone {
  id: string;
  /** Checked for the guard, who sees no resident's name (ADR 0028). */
  fullName?: string;
  phone: string;
  email: string;
  doc: string;
  birthDate: string;
}

/**
 * PII leak scan (ADR 0025): every GET endpoint in the registry, as a
 * resident, a landlord, a family member, a manager and a platform admin,
 * searched for identity-document numbers, birth dates, other people's
 * phones and emails, access codes, tokens and free-text notes.
 */
describe('API v0 — PII leak scan', () => {
  let h: HttpHarness;
  let w: World;

  beforeAll(async () => {
    h = await createHttpHarness();
    w = await buildWorld(h);
  }, 120_000);

  afterAll(() => h.close());

  it('no GET response carries what its reader may not see', async () => {
    const c = w.helpers;
    const a = w.a;
    const manager = <T>(fn: () => Promise<T>) => c.asManager(a, fn);
    const unit = await c.unit(a, `PII-${uniqueSuffix()}`);
    const rented = await c.unit(a, `PII-R-${uniqueSuffix()}`);
    const spare = await c.unit(a, `PII-S-${uniqueSuffix()}`);

    const person = (y: number, m: number, d: number) => {
      const birth = born(y, m, d);
      return {
        fullName: `Pii ${uniqueSuffix()}`,
        idDocumentType: 'national_id' as const,
        idDocumentNumber: nationalIdFor(birth),
        phone: uniquePhone(),
        email: uniqueEmail('pii'),
        birthDate: iso(birth),
      };
    };
    const resident = async (
      p: ReturnType<typeof person>,
      units: {
        unitId: string;
        occupancyType: 'owner' | 'tenant';
        resides?: boolean;
      }[],
    ): Promise<Someone> => {
      const created = await manager(() =>
        c.residents.createResident({
          fullName: p.fullName,
          idDocumentType: p.idDocumentType,
          idDocumentNumber: p.idDocumentNumber,
          phone: p.phone,
          email: p.email,
          units,
        }),
      );
      return {
        id: created.id,
        fullName: p.fullName,
        phone: p.phone,
        email: p.email,
        doc: p.idDocumentNumber,
        birthDate: p.birthDate,
      };
    };

    // People.
    const primary = await resident(person(1971, 5, 13), [
      { unitId: unit.id, occupancyType: 'owner' },
    ]);
    const landlord = await resident(person(1965, 2, 17), [
      { unitId: rented.id, occupancyType: 'owner', resides: false },
    ]);
    const tenant = await resident(person(1994, 11, 2), [
      { unitId: rented.id, occupancyType: 'tenant' },
    ]);
    const fp = person(1983, 7, 21);
    const joined = await c.joinFamily(
      a,
      unit.id,
      { id: primary.id },
      {
        idDocumentNumber: fp.idDocumentNumber,
        phone: fp.phone,
        email: fp.email,
      },
    );
    const family: Someone = {
      id: joined.accountId,
      fullName: joined.fullName,
      phone: fp.phone,
      email: fp.email,
      doc: fp.idDocumentNumber,
      birthDate: fp.birthDate,
    };
    const leaving = await resident(person(1959, 8, 8), [
      { unitId: spare.id, occupancyType: 'owner' },
    ]);
    const asPrimary = <T>(fn: () => Promise<T>) =>
      c.as(a, { id: primary.id, type: 'resident' }, fn);

    // Secrets and notes.
    const qp = person(1990, 12, 12);
    const invite = await asPrimary(() =>
      h.moduleRef.get(HouseholdsService).createInvite(unit.id, {
        fullName: qp.fullName,
        idDocumentType: 'national_id',
        idDocumentNumber: qp.idDocumentNumber,
        phone: qp.phone,
        email: qp.email,
        relation: 'sibling',
      }),
    );
    const link = await manager(() =>
      h.moduleRef.get(RegistrationService).createLink(),
    );
    const workers = h.moduleRef.get(WorkersService);
    const wp = person(1979, 9, 30);
    // The worker's photo (ADR 0029): among GETs, only the manager's
    // engagement detail may carry its URL.
    const workerPhoto = await fileHelpers(h).ready(
      await w.tokenFor(a, primary.id, 'resident'),
    );
    const registered = await asPrimary(() =>
      workers.register(unit.id, {
        fullName: wp.fullName,
        idDocumentType: 'national_id',
        idDocumentNumber: wp.idDocumentNumber,
        phone: wp.phone,
        capacity: 'live_in',
        photoFileId: workerPhoto,
      }),
    );
    const firstCode = (await manager(() =>
      workers.review(registered.engagementId, 'approve'),
    ))!.accessCode;
    const incident = await asPrimary(() =>
      workers.reportCardIncident(
        registered.engagementId,
        'lost',
        'PII-NOTE-card',
      ),
    );
    await manager(() =>
      c.residents.tagSeparation(rented.id, {
        code: 'separation',
        text: 'PII-NOTE-flag',
      }),
    );
    const deletion = h.moduleRef.get(AccountDeletionService);
    const request = await c.as(a, { id: leaving.id, type: 'resident' }, () =>
      deletion.requestDeletion('DELETE'),
    );
    await manager(() =>
      deletion.placeLegalHold(leaving.id, {
        code: 'litigation',
        text: 'PII-NOTE-hold',
      }),
    );
    const ender = await resident(person(1977, 3, 3), [
      { unitId: spare.id, occupancyType: 'tenant' },
    ]);
    const enderOccupancy = (await c.occupancies(a, spare.id)).find(
      (o) => o.accountId === ender.id,
    )!;
    await manager(() =>
      c.residents.endOccupancy(enderOccupancy.id, {
        code: 'moved_out',
        text: 'PII-NOTE-end',
      }),
    );
    const removed = await c.joinFamily(a, unit.id, { id: primary.id });
    await asPrimary(() =>
      h.moduleRef.get(HouseholdsService).removeMember(removed.memberId, {
        code: 'moved_out',
        text: 'PII-NOTE-removal',
      }),
    );
    const roles = await manager(() => h.moduleRef.get(RolesService).list());

    const worker: Someone = {
      id: '',
      fullName: wp.fullName,
      phone: wp.phone,
      email: '',
      doc: wp.idDocumentNumber,
      birthDate: wp.birthDate,
    };
    // A family member's visitor: the code and phone are never returned
    // after creation, the name only to the host (ADR 0028).
    const visitorPhone = uniquePhone();
    const visit = await c.as(a, { id: family.id, type: 'family' }, () =>
      h.moduleRef.get(VisitorPassesService).create(unit.id, {
        kind: 'one_time',
        partySize: 2,
        validFrom: new Date(),
        validUntil: new Date(Date.now() + 3_600_000),
        visitorName: 'PII-VISITOR-name',
        visitorPhone,
      }),
    );
    // A guard asks the household about a visitor: the name the guard typed
    // reaches the household's own request list, nowhere else.
    const unitCode = (
      await manager(() =>
        c.prisma.tenant.unit.findUniqueOrThrow({ where: { id: unit.id } }),
      )
    ).code;
    const asked = await c.as(a, { id: a.ids.guard, type: 'staff' }, () =>
      h.moduleRef.get(ApprovalsService).request({
        kind: 'uninvited_visitor',
        unitCode,
        visitorName: 'PII-ASKED-name',
      }),
    );
    // A parcel for the unit (ADR 0035): the label's name is for the unit's
    // residents alone, and the guard sees no code.
    const parcelRes = await parcelHelpers(h).receive(a.tokens.guard, unitCode, {
      labelName: 'PII-PARCEL-label',
    });
    if (parcelRes.status !== 201)
      throw new Error(`parcel: ${parcelRes.status} ${parcelRes.text}`);
    const parcel = parcelRes.body as { id: string };
    const parcelPhotoId = (
      await manager(() =>
        c.prisma.tenant.parcel.findUniqueOrThrow({ where: { id: parcel.id } }),
      )
    ).photoFileId!;
    const parcelHolder = await manager(() =>
      c.prisma.tenant.parcelCredential.findFirstOrThrow({
        where: { parcelId: parcel.id, kind: 'holder' },
      }),
    );
    const parcelCode = h.moduleRef
      .get(ParcelTokens)
      .secretOf(a.tenantId, parcelHolder.id, parcelHolder.attempt).code;
    const people = [primary, landlord, tenant, family, leaving, ender, worker];
    // A resident's entry secret (ADR 0031): shown once, in no GET.
    const entry = (
      await call(w, 'POST', '/me/entry-credentials', {
        token: await w.tokenFor(a, primary.id, 'resident'),
        body: { deviceName: 'PII-DEVICE-name' },
      }).expect(201)
    ).body as { secret: string };
    const secrets = [
      entry.secret,
      visit.code!,
      visitorPhone,
      ...people.map((p) => p.doc),
      qp.idDocumentNumber,
      firstCode,
      incident.accessCode,
      invite.token,
      link.token,
      'PII-NOTE-card',
      'PII-NOTE-flag',
      'PII-NOTE-hold',
      'PII-NOTE-end',
      'PII-NOTE-removal',
    ];
    const birthDates = [...people.map((p) => p.birthDate), qp.birthDate];

    // A worker photo the primary uploaded (ADR 0029): its read URL names the
    // object, so the key is what the scan looks for.
    const photoId = await fileHelpers(h).ready(
      await w.tokenFor(a, primary.id, 'resident'),
    );
    const photoKey = `t/${a.tenantId}/${photoId}`;

    // The residents' own photos (ADR 0031): each is shown in its owner's own
    // `GET /me` and nowhere else (the guard's valid scan is checked in
    // test/gate/resident-qr).
    const ownPhoto = async (token: string) => {
      const id = await fileHelpers(h).ready(token, 'resident_photo');
      await call(w, 'PUT', '/me/photo', { token, body: { fileId: id } }).expect(
        204,
      );
      return `t/${a.tenantId}/${id}`;
    };
    const residentPhotoKey = await ownPhoto(
      await w.tokenFor(a, primary.id, 'resident'),
    );
    const familyPhotoKey = await ownPhoto(
      await w.tokenFor(a, family.id, 'family'),
    );

    // A ticket the family member opened on the primary's unit (ADR 0032).
    const asFamily = <T>(fn: () => Promise<T>) =>
      c.as(a, { id: family.id, type: 'family' }, fn);
    const asManagerA = <T>(fn: () => Promise<T>) => c.asManager(a, fn);
    const asTech = <T>(id: string, fn: () => Promise<T>) =>
      c.as(a, { id, type: 'staff' }, fn);
    const ticketPhoto = await fileHelpers(h).ready(
      await w.tokenFor(a, family.id, 'family'),
      'ticket_photo',
    );
    const ticket = await asFamily(() =>
      h.moduleRef.get(TicketsService).create({
        unitId: unit.id,
        categoryId: w.aCategoryId,
        description: 'PII-TICKET-description',
        photoFileIds: [ticketPhoto],
      }),
    );
    const ticketPhotoKey = `t/${a.tenantId}/${ticketPhoto}`;
    // Another technician took it and declined: dispatch's business, never
    // the next technician's (ADR 0032).
    const declined = await gateHelpers(h).guard(a, 'technician');
    const declinedName = (
      await asManagerA(() =>
        c.prisma.tenant.account.findUniqueOrThrow({
          where: { id: declined.id },
        }),
      )
    ).fullName!;
    const dispatch = h.moduleRef.get(DispatchService);
    const work = h.moduleRef.get(WorkService);
    const messages = h.moduleRef.get(MessagesService);
    await asManagerA(() => dispatch.assign(ticket.id, declined.id));
    await asTech(declined.id, () => work.decline(ticket.id, 'unavailable'));
    await asManagerA(() => dispatch.assign(ticket.id, a.ids.technician));
    await asFamily(() =>
      messages.post(ticket.id, 'resident', 'PII-MESSAGE-family'),
    );
    await asTech(a.ids.technician, () =>
      messages.post(ticket.id, 'technician', 'PII-MESSAGE-technician'),
    );
    await asManagerA(() =>
      messages.post(ticket.id, 'dispatch', 'PII-INTERNAL-note', true),
    );
    await asTech(a.ids.technician, () => work.start(ticket.id));
    await asTech(a.ids.technician, () => work.complete(ticket.id));
    await asFamily(() =>
      h.moduleRef
        .get(ConfirmationService)
        .confirm(ticket.id, 4, 'PII-FEEDBACK-comment'),
    );
    // A ticket still in the queue: no technician sees it.
    const queued = await asPrimary(() =>
      h.moduleRef.get(TicketsService).create({
        unitId: unit.id,
        categoryId: w.aCategoryId,
        description: 'PII-QUEUED-description',
      }),
    );

    // Dispatch (ADR 0033). The engine finds nobody for the queued ticket (an
    // attempt row, an unassignable notice for the dispatchers); then the
    // technician gets a specialty and goes available, so there is a workload
    // and an availability to leak.
    await asManagerA(() => dispatch.autoAssign(queued.id));
    const plumbing = await asManagerA(() =>
      c.prisma.tenant.specialty.findFirstOrThrow({
        where: { key: 'plumbing' },
      }),
    );
    await asManagerA(() =>
      h.moduleRef
        .get(SpecialtiesService)
        .setForTechnician(a.ids.technician, [plumbing.id]),
    );
    await asTech(a.ids.technician, () =>
      h.moduleRef.get(AvailabilityService).setMine('available'),
    );

    // Visits (ADR 0034): an upcoming visit to the primary's home, confirmed,
    // the family member allowing entry while nobody is home and receiving
    // the technician. Its window says when the home is empty: the assigned
    // technician, dispatch and the people who live there only.
    const visitTicket = await asPrimary(() =>
      h.moduleRef.get(TicketsService).create({
        unitId: unit.id,
        categoryId: w.aCategoryId,
        description: 'PII-VISIT-description',
      }),
    );
    await asManagerA(() => dispatch.assign(visitTicket.id, a.ids.technician));
    const visitStart = new Date(Date.now() + 2 * 86_400_000);
    visitStart.setUTCMilliseconds(777);
    const visitEnd = new Date(visitStart.getTime() + 90 * 60_000);
    const visitsService = h.moduleRef.get(VisitsService);
    const homeVisit = await asTech(a.ids.technician, () =>
      visitsService.propose(
        visitTicket.id,
        { startsAt: visitStart, endsAt: visitEnd },
        'technician',
      ),
    );
    await asPrimary(() =>
      visitsService.confirm(visitTicket.id, homeVisit.id, 'resident'),
    );
    const consentService = h.moduleRef.get(VisitConsentService);
    await asFamily(() => consentService.grant(visitTicket.id, homeVisit.id));
    await asPrimary(() =>
      consentService.setReceiver(visitTicket.id, homeVisit.id, {
        accountId: family.id,
      }),
    );
    const windowMarks = [visitStart.toISOString(), visitEnd.toISOString()];
    const otherTechnician = await gateHelpers(h).guard(a, 'technician');

    const params: Record<string, string> = {
      '/tickets/{id}': ticket.id,
      '/technician/tickets/{id}': ticket.id,
      '/tickets/{id}/messages': ticket.id,
      '/technician/tickets/{id}/messages': ticket.id,
      '/maintenance/tickets/{id}/messages': ticket.id,
      '/maintenance/tickets/{id}': ticket.id,
      '/maintenance/tickets/{id}/history': ticket.id,
      '/maintenance/tickets/{id}/assignments': ticket.id,
      '/maintenance/tickets/{id}/dispatch-attempts': queued.id,
      '/maintenance/tickets/{id}/sla-events': ticket.id,
      '/tickets/{id}/visits': visitTicket.id,
      '/technician/tickets/{id}/visits': visitTicket.id,
      '/maintenance/tickets/{id}/visits': visitTicket.id,
      '/maintenance/tickets/{id}/visit-events': visitTicket.id,
      '/me/units/{unitId}/visits': unit.id,
      '/files/{id}': photoId,
      '/units/{id}': unit.id,
      '/units/{id}/activation': unit.id,
      '/units/{id}/household/to-review': unit.id,
      '/units/{unitId}/household': unit.id,
      '/units/{unitId}/household/minors-ready': unit.id,
      '/units/{unitId}/workers': unit.id,
      '/units/{unitId}/deferred-actions': unit.id,
      '/units/{unitId}/delegations': unit.id,
      '/units/{unitId}/visitor-passes': unit.id,
      '/units/{unitId}/gate-instructions': unit.id,
      '/gate/approval-requests/{id}': asked.id,
      '/gate/parcels/{id}': parcel.id,
      '/me/parcels/{id}': parcel.id,
      '/parcels/{id}': parcel.id,
      '/me/units/{unitId}/capabilities': unit.id,
      '/me/units/{unitId}/permissions': unit.id,
      '/residents/{id}': primary.id,
      '/accounts/{id}': primary.id,
      '/accounts/{id}/legal-holds': leaving.id,
      '/household/members/{id}/permissions': joined.memberId,
      '/roles/{id}': roles[0].id,
      '/erasures/{id}/scope': request.id,
      '/worker-engagements/{id}': registered.engagementId,
      '/worker-engagements/{id}/attendance': registered.engagementId,
      '/platform/tenants/{id}': a.tenantId,
    };
    /** Where a manager may see a birth date: one person's detail. */
    const managerDetails = new Set([
      '/residents/{id}',
      '/accounts/{id}',
      '/worker-engagements/{id}',
    ]);

    const gets = ROUTES.filter((r) => r.method === 'GET');
    const missing = gets
      .filter((r) => paramNames(r.path).length && !(r.path in params))
      .map((r) => r.path);
    expect(missing).toEqual([]);

    const personas = {
      manager: {
        token: a.tokens.manager,
        self: a.ids.manager,
        isManager: true,
      },
      resident: {
        token: await w.tokenFor(a, primary.id, 'resident'),
        self: primary.id,
        isManager: false,
      },
      landlord: {
        token: await w.tokenFor(a, landlord.id, 'resident'),
        self: landlord.id,
        isManager: false,
      },
      family: {
        token: await w.tokenFor(a, family.id, 'family'),
        self: family.id,
        isManager: false,
      },
      platform: { token: w.platform.token, self: '', isManager: false },
      // A guard on duty at A's gate: the gate's own views only.
      guard: { token: a.tokens.guard, self: a.ids.guard, isManager: false },
      // A maintenance technician (ADR 0032): their own tickets only.
      technician: {
        token: a.tokens.technician,
        self: a.ids.technician,
        isManager: false,
      },
      // ADR 0034: another technician, and someone whose occupancy ended,
      // never see a visit's window, consent or receiver.
      otherTechnician: {
        token: await w.tokenFor(a, otherTechnician.id, 'staff'),
        self: otherTechnician.id,
        isManager: false,
      },
      ender: {
        token: await w.tokenFor(a, ender.id, 'resident'),
        self: ender.id,
        isManager: false,
      },
    };

    const leaks: string[] = [];
    const seen = new Map<string, string>();
    for (const [name, persona] of Object.entries(personas)) {
      for (const r of gets) {
        const path = paramNames(r.path).length
          ? fill(
              r.path,
              Object.fromEntries(
                paramNames(r.path).map((n) => [n, params[r.path]]),
              ),
            )
          : r.path;
        const isPlatformRoute = r.auth === 'platform';
        if ((name === 'platform') !== isPlatformRoute && r.auth !== 'public')
          continue;
        const res = await call(w, 'GET', path, {
          token: r.auth === 'public' ? undefined : persona.token,
        });
        const text = res.text ?? '';
        seen.set(`${name} ${r.path}`, text);
        const found = (s: string) => s && text.includes(s);
        for (const s of secrets)
          if (found(s)) leaks.push(`${name} ${r.path}: secret ${s}`);
        const others = people.filter((p) => p.id !== persona.self);
        if (name === 'guard') {
          for (const p of others)
            if (p.fullName && found(p.fullName))
              leaks.push(`${name} ${r.path}: a resident's name`);
          if (found('PII-VISITOR-name') || found('PII-ASKED-name'))
            leaks.push(`${name} ${r.path}: a visitor's name`);
        }
        if (name === 'technician') {
          // First names only, never a resident's account id, never what
          // is dispatch's (who declined, ratings and comments, the queue).
          for (const p of others)
            if (p.fullName && found(p.fullName))
              leaks.push(`${name} ${r.path}: a resident's name`);
          // Ids only in a success: an error's `path` echoes the request.
          if (res.status < 300)
            for (const id of [family.id, primary.id, declined.id])
              if (found(id)) leaks.push(`${name} ${r.path}: ${id}`);
          for (const s of [
            declinedName,
            'PII-FEEDBACK-comment',
            // Not where the request itself names it (an error echoes its path).
            ...(r.path === '/maintenance/tickets/{id}/dispatch-attempts'
              ? []
              : [queued.id]),
            'PII-QUEUED-description',
            w.bTicketId,
          ])
            if (found(s)) leaks.push(`${name} ${r.path}: ${s}`);
        }
        // Visits (ADR 0034): a window, a consent and a receiver tell when a
        // home is empty. Never a guard, a landlord (who does not live
        // there), another technician or someone who left.
        if (['guard', 'landlord', 'otherTechnician', 'ender'].includes(name))
          for (const s of [...windowMarks, '"absenceEntry', '"receiver"'])
            if (found(s)) leaks.push(`${name} ${r.path}: visit ${s}`);
        // The assigned technician: whether entry is allowed and a first
        // name, never who allowed it or who the receiver is.
        if (name === 'technician')
          for (const s of ['"grantedBy"', '"consentBy', family.id])
            if (res.status < 300 && found(s))
              leaks.push(`${name} ${r.path}: ${s}`);
        // Never in the audit trail, whoever reads it.
        if (r.path.includes('audit'))
          for (const s of [...windowMarks, 'absence', 'receiver', 'consent'])
            if (found(s)) leaks.push(`${name} ${r.path}: audit ${s}`);
        if (['resident', 'landlord', 'family', 'guard'].includes(name)) {
          // Internal messages and ratings are staff's (ADR 0032).
          for (const s of ['PII-INTERNAL-note', 'PII-FEEDBACK-comment'])
            if (found(s)) leaks.push(`${name} ${r.path}: ${s}`);
        }
        // Dispatch (ADR 0033): workload, availability, specialties and the
        // engine's attempts are dispatch's. A technician sees only their own
        // availability, at their own route; residents see none of it, and
        // nobody but dispatch is told a ticket is unassignable.
        if (name !== 'manager' && name !== 'platform') {
          const dispatchOnly = [
            '"workload"',
            '"candidateCount"',
            '"specialties"',
            '"specialtyIds"',
            'ticket.unassignable',
            ...(r.path === '/technician/availability'
              ? []
              : ['"availability"']),
          ];
          for (const s of dispatchOnly)
            if (found(s)) leaks.push(`${name} ${r.path}: ${s}`);
        }
        if (!persona.isManager) {
          for (const p of others) {
            if (found(p.phone)) leaks.push(`${name} ${r.path}: phone`);
            if (found(p.email)) leaks.push(`${name} ${r.path}: email`);
          }
          for (const b of birthDates)
            if (found(b)) leaks.push(`${name} ${r.path}: birth date`);
        } else if (!managerDetails.has(r.path)) {
          for (const b of birthDates)
            if (found(b)) leaks.push(`${name} ${r.path}: birth date`);
        }
      }
    }
    expect(leaks).toEqual([]);

    // A file's read URL: its owner's own GET, nowhere else; a worker's
    // photo: the manager's engagement detail only (not residents' lists).
    const fileViews: [string, Set<string>][] = [
      [photoKey, new Set(['resident /files/{id}'])],
      [residentPhotoKey, new Set(['resident /me'])],
      [familyPhotoKey, new Set(['family /me'])],
      [
        `t/${a.tenantId}/${workerPhoto}`,
        new Set(['manager /worker-engagements/{id}']),
      ],
      // A ticket's photo: the ticket's own details, for those who see it.
      [
        ticketPhotoKey,
        new Set([
          'family /tickets/{id}',
          'resident /tickets/{id}',
          'technician /technician/tickets/{id}',
          'manager /maintenance/tickets/{id}',
        ]),
      ],
    ];
    // A parcel's photo: the guard's detail, and the unit's own residents.
    fileViews.push([
      `t/${a.tenantId}/${parcelPhotoId}`,
      new Set([
        'guard /gate/parcels/{id}',
        'resident /me/parcels/{id}',
        'resident /me/parcels',
        'family /me/parcels/{id}',
        'family /me/parcels',
      ]),
    ]);
    for (const [fileKey, views] of fileViews) {
      for (const [key, text] of seen) {
        if (!views.has(key) && text.includes(fileKey))
          leaks.push(`${key}: a file URL`);
      }
      for (const key of views) expect(seen.get(key)).toContain(fileKey);
    }
    expect(seen.get('resident /units/{unitId}/workers')).toContain(
      registered.engagementId,
    );

    // A phone's name: its owner's own list, nobody else's, and no secret.
    for (const [key, text] of seen) {
      if (key !== 'resident /me/entry-credentials')
        if (text.includes('PII-DEVICE-name')) leaks.push(`${key}: device name`);
    }
    expect(seen.get('resident /me/entry-credentials')).toContain(
      'PII-DEVICE-name',
    );

    // The label's name and the pickup code (ADR 0035): the unit's residents
    // alone, never the guard, the manager, a landlord or anyone else.
    const parcelViews = new Set([
      'resident /me/parcels',
      'resident /me/parcels/{id}',
      'family /me/parcels',
      'family /me/parcels/{id}',
    ]);
    for (const [key, text] of seen) {
      if (parcelViews.has(key)) continue;
      if (text.includes('PII-PARCEL-label')) leaks.push(`${key}: label name`);
      if (text.includes(`"code":"${parcelCode}"`))
        leaks.push(`${key}: the pickup code`);
    }
    expect(leaks).toEqual([]);
    for (const key of parcelViews) {
      expect(seen.get(key)).toContain('PII-PARCEL-label');
      expect(seen.get(key)).toContain(`"code":"${parcelCode}"`);
    }

    // The visitor's name: its host sees it, nobody else does.
    for (const [key, text] of seen) {
      if (key === 'family /units/{unitId}/visitor-passes') continue;
      if (text.includes('PII-VISITOR-name')) leaks.push(`${key}: visitor name`);
    }
    // The household's request list and its own notifications about it.
    const household = new Set([
      'resident /me/gate-requests',
      'family /me/gate-requests',
      'resident /me/notifications',
      'family /me/notifications',
    ]);
    for (const [key, text] of seen) {
      if (!household.has(key) && text.includes('PII-ASKED-name'))
        leaks.push(`${key}: asked visitor name`);
    }
    expect(leaks).toEqual([]);
    for (const key of household)
      expect(seen.get(key)).toContain('PII-ASKED-name');
    expect(seen.get('family /units/{unitId}/visitor-passes')).toContain(
      'PII-VISITOR-name',
    );
    expect(seen.get('resident /units/{unitId}/visitor-passes')).toContain(
      visit.id,
    );

    // Visits, positively (ADR 0034): those who live there and the assigned
    // technician see the window; the technician learns whether entry is
    // allowed and the receiver's first name; dispatch's history has no
    // window. Notification params carry the number and the window only.
    expect(seen.get('family /tickets/{id}/visits')).toContain(windowMarks[0]);
    expect(seen.get('resident /me/units/{unitId}/visits')).toContain(
      windowMarks[0],
    );
    const techVisits = seen.get('technician /technician/tickets/{id}/visits')!;
    expect(techVisits).toContain(windowMarks[0]);
    expect(techVisits).toContain('"absenceEntryApproved":true');
    expect(techVisits).toContain(
      `"receiver":{"kind":"household","firstName":"${family.fullName!.split(' ')[0]}"}`,
    );
    const visitEvents = seen.get(
      'manager /maintenance/tickets/{id}/visit-events',
    )!;
    expect(visitEvents).toContain('consent_granted');
    for (const mark of windowMarks) expect(visitEvents).not.toContain(mark);
    const visitNotices = await manager(() =>
      c.prisma.tenant.notification.findMany({
        where: { kind: { startsWith: 'ticket.visit_' } },
      }),
    );
    expect(visitNotices.length).toBeGreaterThan(0);
    for (const n of visitNotices)
      expect(Object.keys(n.params as object).sort()).toEqual([
        'endsAt',
        'startsAt',
        'ticketNumber',
      ]);
    const auditRows = await manager(() => c.prisma.tenant.auditLog.findMany());
    const auditText = JSON.stringify(auditRows);
    for (const s of [...windowMarks, homeVisit.id, 'absence', 'receiver'])
      expect(auditText).not.toContain(s);

    // The technician reads their ticket: the work, the reporter's first
    // name, the thread with its internal note — and nothing of dispatch's.
    const techTicket = seen.get('technician /technician/tickets/{id}')!;
    expect(techTicket).toContain('PII-TICKET-description');
    expect(techTicket).toContain(
      `"reporterFirstName":"${family.fullName!.split(' ')[0]}"`,
    );
    expect(seen.get('technician /technician/tickets/{id}/messages')).toContain(
      'PII-INTERNAL-note',
    );
    expect(
      seen.get('technician /maintenance/tickets/{id}/assignments'),
    ).toContain('FORBIDDEN');
    expect(seen.get('manager /maintenance/tickets/{id}/assignments')).toContain(
      declined.id,
    );
    expect(seen.get('manager /maintenance/tickets/{id}')).toContain(
      'PII-FEEDBACK-comment',
    );
    // Residents read the thread without the internal note.
    expect(seen.get('family /tickets/{id}/messages')).toContain(
      'PII-MESSAGE-technician',
    );
    expect(seen.get('resident /tickets/{id}')).toContain(
      'PII-TICKET-description',
    );

    // The guard reads the gate's views (and nothing else).
    expect(seen.get('guard /gate/shifts/current')).toContain(a.gateName);
    expect(seen.get('guard /gate/approval-requests/{id}')).toContain(asked.id);
    expect(seen.get('guard /residents')).toContain('FORBIDDEN');

    // Positive controls: the scan reads real data, where it is allowed.
    expect(seen.get('manager /residents/{id}')).toContain(primary.birthDate);
    expect(seen.get('manager /residents')).toContain(primary.phone);
    expect(seen.get('resident /me')).toContain(primary.phone);
    expect(seen.get('resident /units/{unitId}/household')).toContain(
      joined.fullName,
    );
    expect(seen.get('manager /worker-engagements/{id}')).toContain(wp.phone);
    expect(seen.get('manager /card-incidents')).toContain(incident.incidentId);

    // The public persona (ADR 0030): whoever holds a visitor's link. The
    // page reads by the link's token; for the family member's pass (with a
    // visitor name and phone) and one of the primary's, it shows no person
    // and no secret but the pass's own code.
    const primaryVisit = await c.as(
      a,
      { id: primary.id, type: 'resident' },
      () =>
        h.moduleRef.get(VisitorPassesService).create(unit.id, {
          kind: 'one_time',
          partySize: 1,
          validFrom: new Date(),
          validUntil: new Date(Date.now() + 3_600_000),
        }),
    );
    const publicReads = ROUTES.filter(
      (r) => r.auth === 'public' && r.path.endsWith('/lookup'),
    ).map((r) => r.path);
    expect(publicReads).toEqual(['/public/visitor-passes/lookup']);
    const ids = [...people.map((p) => p.id), ...Object.values(a.ids)].filter(
      Boolean,
    );
    for (const [host, issued] of [
      ['family', visit],
      ['primary', primaryVisit],
    ] as const) {
      for (const path of publicReads) {
        const res = await call(w, 'POST', path, {
          body: { token: issued.link!.split('#')[1] },
        }).expect(200);
        const text = res.text;
        const found = (v: string) => v && text.includes(v);
        for (const p of people)
          for (const v of [
            p.fullName ?? '',
            p.phone,
            p.email,
            p.doc,
            p.birthDate,
          ])
            if (found(v)) leaks.push(`public ${host} ${path}: a person's data`);
        for (const id of ids)
          if (found(id)) leaks.push(`public ${host} ${path}: an account id`);
        for (const v of ['PII-VISITOR-name', visitorPhone, 'PII-ASKED-name'])
          if (found(v)) leaks.push(`public ${host} ${path}: a visitor's data`);
        for (const secret of secrets)
          if (secret !== issued.code && found(secret))
            leaks.push(`public ${host} ${path}: secret ${secret}`);
        // Positive control: the pass's own code is there.
        expect(text).toContain(issued.code!);
      }
    }
    expect(leaks).toEqual([]);
  });
});
