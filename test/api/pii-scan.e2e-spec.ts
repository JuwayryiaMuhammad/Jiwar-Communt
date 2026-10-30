import { DelegationsService } from '../../src/community/households/delegations.service';
import { HouseholdsService } from '../../src/community/households/households.service';
import { RegistrationService } from '../../src/community/residents/registration.service';
import { WorkerWagesService } from '../../src/community/workers/worker-wages.service';
import { WorkersService } from '../../src/community/workers/workers.service';
import { RolesService } from '../../src/core/access/roles.service';
import { AccountDeletionService } from '../../src/core/accounts/account-deletion.service';
import { ParcelTokens } from '../../src/gate/parcels/parcel-tokens';
import { ConsentsService } from '../../src/core/consents/consents.service';
import { VisitorPassesService } from '../../src/gate/visitors/visitor-passes.service';
import { ApprovalsService } from '../../src/gate/approvals/approvals.service';
import { StandingInstructionsService } from '../../src/gate/visitors/standing-instructions.service';
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
import { bornYearsAgo, nationalIdFor, uniqueSuffix } from '../setup/fixtures';
import {
  createHttpHarness,
  uniqueEmail,
  uniquePhone,
  type HttpHarness,
} from '../setup/http-app';
import { fill, paramNames, call } from './request';
import { ROUTES } from './routes';
import { buildWorld, sessionOf, type World } from './world';
import { ShiftsService } from '../../src/gate/shifts/shifts.service';
import { TasksService } from '../../src/gate/tasks/tasks.service';
import { CheckpointsService } from '../../src/gate/patrols/checkpoints.service';
import { GlobalDbService } from '../../src/core/database/global-db.service';
import { TenantTx } from '../../src/core/database/tenant-tx.service';
import { paymentRow } from '../setup/finance-rows';
import { month, ofDbDate } from '../setup/compound-clock';

const born = (y: number, m: number, d: number) =>
  new Date(Date.UTC(y, m - 1, d));
const iso = ofDbDate;
import { at, day } from '../setup/facilities';
import { BlocklistService } from '../../src/gate/blocklist/blocklist.service';
import { FieldExceptionsService } from '../../src/gate/exceptions/field-exceptions.service';
/** A name's first word: what first-name views show. */
const first = (fullName?: string) => fullName?.split(' ')[0] ?? '';

interface Someone {
  id: string;
  /**
   * Checked for the guard, who sees no resident's name (ADR 0028), and for
   * the landlord and the ender, who see no household's (ADR 0016, 0020).
   */
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
        fullName: `Pii${uniqueSuffix()} Person`,
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
    // The household of the unit the landlord rents out (ADR 0016, 0020):
    // the tenant is its primary; a co-tenant, a family member, a minor and
    // a domestic worker live there too, and the tenant delegates to the
    // family member. The landlord sees none of them; nor does the ender,
    // who lived there and left (below).
    const asTenant = <T>(fn: () => Promise<T>) =>
      c.as(a, { id: tenant.id, type: 'resident' }, fn);
    const coTenant = await resident(person(1988, 4, 4), [
      { unitId: rented.id, occupancyType: 'tenant' },
    ]);
    const rp = person(1986, 6, 6);
    const rentedJoined = await c.joinFamily(
      a,
      rented.id,
      { id: tenant.id },
      {
        fullName: rp.fullName,
        idDocumentNumber: rp.idDocumentNumber,
        phone: rp.phone,
        email: rp.email,
      },
    );
    const rentedFamily: Someone = {
      id: rentedJoined.accountId,
      fullName: rp.fullName,
      phone: rp.phone,
      email: rp.email,
      doc: rp.idDocumentNumber,
      birthDate: rp.birthDate,
    };
    const mp = person(2017, 3, 9);
    const rentedMinor = await asTenant(() =>
      h.moduleRef.get(HouseholdsService).addMinor(rented.id, {
        fullName: mp.fullName,
        idDocumentType: 'national_id',
        idDocumentNumber: mp.idDocumentNumber,
        relation: 'child',
      }),
    );
    const minor: Someone = {
      id: rentedMinor.id,
      fullName: mp.fullName,
      phone: '',
      email: '',
      doc: mp.idDocumentNumber,
      birthDate: mp.birthDate,
    };
    const rwp = person(1984, 1, 21);
    const rentedEngagement = await asTenant(() =>
      h.moduleRef.get(WorkersService).register(rented.id, {
        fullName: rwp.fullName,
        idDocumentType: 'national_id',
        idDocumentNumber: rwp.idDocumentNumber,
        phone: rwp.phone,
        capacity: 'live_in',
      }),
    );
    await manager(() =>
      h.moduleRef
        .get(WorkersService)
        .review(rentedEngagement.engagementId, 'approve'),
    );
    const rentedWorker: Someone = {
      id: '',
      fullName: rwp.fullName,
      phone: rwp.phone,
      email: '',
      doc: rwp.idDocumentNumber,
      birthDate: rwp.birthDate,
    };
    await asTenant(() =>
      h.moduleRef.get(DelegationsService).create(
        rented.id,
        rentedFamily.id,
        ['workers'],
        // eslint-disable-next-line no-restricted-syntax -- any future instant within a year: a delegation's expiry is an instant
        new Date(Date.now() + 30 * 86_400_000),
      ),
    );
    // The spare unit's own primary: `leaving` lives there beside them,
    // since a primary may not ask to be deleted (ADR 0036).
    await resident(person(1950, 1, 1), [
      { unitId: spare.id, occupancyType: 'owner' },
    ]);
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
    // Wages (ADR 0037): a wage and a recorded payment in both homes, in
    // amounts nothing else in the scan produces. Only the employer side
    // and the managers who review workers ever read them.
    const wages = h.moduleRef.get(WorkerWagesService);
    const wageMonth = month();
    const WAGE = { home: '7313.37', rented: '6424.46' };
    const PAID = { home: '5151.51', rented: '4242.42' };
    await asPrimary(() => wages.setWage(registered.engagementId, WAGE.home));
    await asPrimary(() =>
      wages.pay(registered.engagementId, {
        period: wageMonth,
        amount: PAID.home,
      }),
    );
    await asTenant(() =>
      wages.setWage(rentedEngagement.engagementId, WAGE.rented),
    );
    await asTenant(() =>
      wages.pay(rentedEngagement.engagementId, {
        period: wageMonth,
        amount: PAID.rented,
      }),
    );
    // A member of the home with no `workers` delegation and no permission.
    const plainMember = await c.joinFamily(a, unit.id, { id: primary.id });
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
    // The ender lived in the rented unit, opened a ticket there and left.
    // The tenant wrote in its thread before the end (the ender still reads
    // that, ADR 0032) and after it (the ender does not).
    const ender = await resident(person(1977, 3, 3), [
      { unitId: rented.id, occupancyType: 'tenant' },
    ]);
    const oldTicket = await c.as(a, { id: ender.id, type: 'resident' }, () =>
      h.moduleRef.get(TicketsService).create({
        unitId: rented.id,
        categoryId: w.aCategoryId,
        description: 'PII-OLD-description',
      }),
    );
    await manager(() =>
      h.moduleRef.get(DispatchService).assign(oldTicket.id, a.ids.technician),
    );
    await asTenant(() =>
      h.moduleRef
        .get(MessagesService)
        .post(oldTicket.id, 'resident', 'PII-THREAD-before'),
    );
    // The ender also allowed the technician their phone (ADR 0036): once
    // they have no place in the unit, the technician never sees it.
    const consents = h.moduleRef.get(ConsentsService);
    await c.as(a, { id: ender.id, type: 'resident' }, () =>
      consents.grant('ticket_phone_share', 1),
    );
    const enderOccupancy = (await c.occupancies(a, rented.id)).find(
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
    // A standing instruction (ADR 0043): the household's inviters and the
    // guard handling a visitor for the unit read it; nobody else does.
    await c.as(a, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef.get(StandingInstructionsService).create(unit.id, {
        description: 'PII-INSTRUCTION-text',
        action: 'call_first',
      }),
    );
    const asked = await c.as(a, { id: a.ids.guard, type: 'staff' }, () =>
      h.moduleRef.get(ApprovalsService).request({
        kind: 'uninvited_visitor',
        unitCode,
        visitorName: 'PII-ASKED-name',
      }),
    );
    // A field exception the guard raises (ADR 0056): the visitor's name is
    // for the management deciding it, never back to the gate or the home.
    const piiException = await c.as(a, { id: a.ids.guard, type: 'staff' }, () =>
      h.moduleRef.get(FieldExceptionsService).raise({
        kind: 'visitor_without_pass',
        reasonCode: 'resident_unreachable',
        unitCode,
        visitorName: 'PII-EXCEPTION-name',
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
    /** Who lives in the landlord's rented unit now. */
    const rentedHousehold = [
      tenant,
      coTenant,
      rentedFamily,
      minor,
      rentedWorker,
    ];
    const people = [
      primary,
      landlord,
      tenant,
      family,
      leaving,
      ender,
      worker,
      coTenant,
      rentedFamily,
      minor,
      rentedWorker,
    ];
    // A resident's entry secret (ADR 0031): shown once, in no GET.
    const entry = (
      await call(w, 'POST', '/me/entry-credentials', {
        token: await w.tokenFor(a, primary.id, 'resident'),
        body: { deviceName: 'PII-DEVICE-name' },
      }).expect(201)
    ).body as { secret: string };
    // A checkpoint's QR (ADR 0052): answered once, in no GET; nor its hash.
    const checkpointQr = await c.asManager(a, () =>
      h.moduleRef.get(CheckpointsService).create({
        gateId: a.gateId,
        nameEn: 'PII checkpoint',
        nameAr: 'نقطة الفحص',
      }),
    );
    const checkpointHash = (
      await c.asManager(a, () =>
        c.prisma.tenant.patrolCheckpoint.findUniqueOrThrow({
          where: { id: checkpointQr.id },
        }),
      )
    ).tokenHash;
    // A banned person (ADR 0053): their name and face reach only the guards
    // on shift (the active list) and the blocklist's keepers; their ID
    // number reaches nobody, nor its hash.
    const blockedFace = await fileHelpers(h).ready(
      a.tokens.manager,
      'blocklist_photo',
    );
    const blocked = await c.asManager(a, () =>
      h.moduleRef.get(BlocklistService).create({
        kind: 'ban',
        subject: 'person',
        fullName: 'PII-BLOCKLISTED person',
        idNumber: 'PIIX774411',
        photoFileId: blockedFace,
        reasonCode: 'trespassing',
        note: 'PII-NOTE-blocklist',
      }),
    );
    const blockedFaceKey = `t/${a.tenantId}/${blockedFace}`;
    const secrets = [
      'PIIX774411',
      blocked.entry.idHash!,
      checkpointQr.qrPayload.split('.')[2],
      checkpointHash,
      entry.secret,
      visit.code!,
      visitorPhone,
      ...people.map((p) => p.doc),
      qp.idDocumentNumber,
      firstCode,
      incident.accessCode,
      invite.token,
      link.token,
      // A partner's desk link (ADR 0060): shown once, never read back.
      w.aDeskToken,
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

    // A child under exit control (ADR 0054), in the primary's own unit: the
    // child's name and photo are the household's (and a guard's check of
    // the child, a POST: test/children/exits).
    const childName = 'Pii Childname Sentinel';
    const childToken = await w.tokenFor(a, primary.id, 'resident');
    const child = (
      await call(w, 'POST', `/units/${unit.id}/household/minors`, {
        token: childToken,
        body: {
          fullName: childName,
          idDocumentType: 'national_id',
          idDocumentNumber: nationalIdFor(bornYearsAgo(6)),
          relation: 'child',
        },
      }).expect(201)
    ).body as { id: string };
    await call(w, 'POST', `/units/${unit.id}/children/${child.id}/control`, {
      token: childToken,
      body: { mayLeaveAlone: false, notifyPickups: true },
    }).expect(201);
    const childPhotoId = await fileHelpers(h).ready(childToken, 'child_photo');
    await call(
      w,
      'PUT',
      `/units/${unit.id}/children/${child.id}/control/photo`,
      { token: childToken, body: { fileId: childPhotoId } },
    ).expect(204);
    const childPhotoKey = `t/${a.tenantId}/${childPhotoId}`;
    // The child's outside escort (ADR 0054): their name and phone are the
    // household's; the guard sees a first name and a photo at the gate.
    const escortName = 'Pii Escortname Sentinel';
    const escortPhone = uniquePhone();
    await call(
      w,
      'POST',
      `/units/${unit.id}/children/${child.id}/control/escorts`,
      {
        token: childToken,
        body: {
          kind: 'outside',
          outside: { fullName: escortName, phone: escortPhone },
        },
      },
    ).expect(201);
    // An unauthorized pickup of the child at A's gate (ADR 0054): the
    // household reads its record; the keepers read the alert, without the
    // child.
    const childCard = (
      await call(
        w,
        'POST',
        `/units/${unit.id}/children/${child.id}/control/card`,
        { token: childToken },
      ).expect(200)
    ).body as { card: { qrPayload: string } };
    const childAlert = (
      await call(w, 'POST', '/gate/children/exits', {
        token: a.tokens.guard,
        body: {
          card: childCard.card.qrPayload,
          escort: { unidentified: true },
        },
      }).expect(201)
    ).body as { pickupId: string };

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
    // A common-area ticket: its label is free text (ADR 0032), the
    // reporter's and dispatch's only while nobody is assigned.
    await asPrimary(() =>
      h.moduleRef.get(TicketsService).create({
        commonArea: 'PII-AREA-text',
        categoryId: w.aCategoryId,
        description: 'PII-AREA-description',
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
    // eslint-disable-next-line no-restricted-syntax -- within a visit's lead (15 min to 30 × 24 h), checked in ms
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
    // ADR 0036: the primary and the family member allow the technician
    // their phone. The family member's ticket is closed, so it never shows;
    // the primary's visit ticket is open and assigned, so the technician's
    // own detail of it — and nothing else — shows the primary's phone.
    await asPrimary(() => consents.grant('ticket_phone_share', 1));
    await asFamily(() => consents.grant('ticket_phone_share', 1));
    const otherTechnician = await gateHelpers(h).guard(a, 'technician');

    // After the ender left: the tenant writes again, and the ender's old
    // ticket gets a visit, confirmed, the co-tenant allowing entry while
    // nobody is home and the worker receiving the technician. The ender is
    // told none of it and reaches none of it (ADR 0032, 0034).
    await asTenant(() =>
      messages.post(oldTicket.id, 'resident', 'PII-THREAD-after'),
    );
    // eslint-disable-next-line no-restricted-syntax -- within a visit's lead (15 min to 30 × 24 h), checked in ms
    const oldStart = new Date(Date.now() + 3 * 86_400_000);
    oldStart.setUTCMilliseconds(555);
    const oldEnd = new Date(oldStart.getTime() + 60 * 60_000);
    const oldVisit = await asTech(a.ids.technician, () =>
      visitsService.propose(
        oldTicket.id,
        { startsAt: oldStart, endsAt: oldEnd },
        'technician',
      ),
    );
    await asTenant(() =>
      visitsService.confirm(oldTicket.id, oldVisit.id, 'resident'),
    );
    await c.as(a, { id: coTenant.id, type: 'resident' }, () =>
      consentService.grant(oldTicket.id, oldVisit.id),
    );
    await asTenant(() =>
      consentService.setReceiver(oldTicket.id, oldVisit.id, {
        engagementId: rentedEngagement.engagementId,
      }),
    );
    windowMarks.push(oldStart.toISOString(), oldEnd.toISOString());

    // Requests to the management (ADR 0039): the primary's, with a reply, a
    // staff note and a rating; and one of the family member's own.
    const generalTopic = await manager(() =>
      c.prisma.tenant.managementRequestTopic.findFirstOrThrow({
        where: { key: 'general' },
      }),
    );
    const primaryToken = await w.tokenFor(a, primary.id, 'resident');
    const openRequest = async (token: string, text: string) =>
      (
        (
          await call(w, 'POST', '/management-requests', {
            token,
            body: { type: 'question', topicId: generalTopic.id, body: text },
          }).expect(201)
        ).body as { id: string }
      ).id;
    const mgmtRequest = await openRequest(primaryToken, 'PII-REQUEST-text');
    await openRequest(
      await w.tokenFor(a, family.id, 'family'),
      'PII-FAMILY-REQUEST-text',
    );
    for (const message of [
      { body: 'PII-REQUEST-reply' },
      { body: 'PII-REQUEST-note', internal: true },
    ])
      await call(w, 'POST', `/management/requests/${mgmtRequest}/messages`, {
        token: a.tokens.manager,
        body: message,
      }).expect(201);
    await call(w, 'POST', `/management/requests/${mgmtRequest}/close`, {
      token: a.tokens.manager,
      body: { reasonCode: 'resolved' },
    }).expect(204);
    await call(w, 'POST', `/management-requests/${mgmtRequest}/rating`, {
      token: primaryToken,
      body: { rating: 2, comment: 'PII-REQUEST-comment' },
    }).expect(201);

    // Community life (ADR 0040): an announcement that is out; an event the
    // primary is going to; a poll their home voted in; and a suggestion of
    // theirs, answered, on the board under the staff's summary, and done.
    const staffPost = async (path: string, body: object) =>
      (
        (
          await call(w, 'POST', path, {
            token: a.tokens.manager,
            body,
          }).expect(201)
        ).body as { id: string }
      ).id;
    const piiAnnouncement = await staffPost('/community/announcements', {
      kind: 'general',
      titleEn: 'PII-ANNOUNCEMENT-title',
      bodyEn: 'PII-ANNOUNCEMENT-body',
    });
    await call(
      w,
      'POST',
      `/community/announcements/${piiAnnouncement}/publish`,
      {
        token: a.tokens.manager,
      },
    ).expect(204);
    const piiEvent = await staffPost('/community/events', {
      titleEn: 'PII-EVENT-title',
      descriptionEn: 'PII-EVENT-description',
      place: 'PII-EVENT-place',
      // eslint-disable-next-line no-restricted-syntax -- any future instant: events and polls compare instants only
      startsAt: new Date(Date.now() + 86_400_000),
      endsAt: new Date(Date.now() + 90_000_000),
    });
    await call(w, 'PUT', `/events/${piiEvent}/rsvp`, {
      token: primaryToken,
      body: { response: 'going', guests: 1, unitId: unit.id },
    }).expect(204);
    const piiPoll = await staffPost('/community/polls', {
      questionEn: 'PII-POLL-question?',
      options: [{ labelEn: 'Yes' }, { labelEn: 'No' }],
      // eslint-disable-next-line no-restricted-syntax -- any future instant: events and polls compare instants only
      closesAt: new Date(Date.now() + 86_400_000),
    });
    const piiSuggestionTopic = await manager(() =>
      c.prisma.tenant.suggestionTopic.findFirstOrThrow({
        where: { key: 'general' },
      }),
    );
    const piiSuggestion = (
      (
        await call(w, 'POST', '/suggestions', {
          token: primaryToken,
          body: {
            topicId: piiSuggestionTopic.id,
            body: 'PII-SUGGESTION-text',
            unitId: unit.id,
          },
        }).expect(201)
      ).body as { id: string }
    ).id;
    await call(w, 'POST', `/community/suggestions/${piiSuggestion}/status`, {
      token: a.tokens.manager,
      body: { status: 'done', response: 'PII-SUGGESTION-answer' },
    }).expect(204);
    await call(w, 'POST', `/community/suggestions/${piiSuggestion}/publish`, {
      token: a.tokens.manager,
      body: { titleEn: 'PII-SUMMARY-title', textEn: 'PII-SUMMARY-text' },
    }).expect(204);
    await call(w, 'PUT', `/community/suggestions/${piiSuggestion}/done-note`, {
      token: a.tokens.manager,
      body: { noteEn: 'PII-DONE-note' },
    }).expect(204);

    // Neighbours (ADR 0042). The primary complains about the rented unit
    // (its notice goes to the tenant); the tenant complains about the
    // primary's home (its notice comes to the primary); a found post of the
    // primary's with the tenant's claim and a conversation nobody reported;
    // and a lending post with a conversation the primary reported.
    await call(w, 'PATCH', '/neighbours/settings', {
      token: a.tokens.manager,
      body: { maxOpenComplaints: 50, maxOpenPosts: 50 },
    }).expect(200);
    const neighbourToken = await w.tokenFor(a, tenant.id, 'resident');
    const noise = await manager(() =>
      c.prisma.tenant.neighbourComplaintCategory.findFirstOrThrow({
        where: { key: 'noise' },
      }),
    );
    const idOf = async (
      method: 'POST',
      path: string,
      token: string,
      body: object,
    ) =>
      (
        (await call(w, method, path, { token, body }).expect(201)).body as {
          id: string;
        }
      ).id;
    const piiComplaint = await idOf(
      'POST',
      '/neighbour-complaints',
      primaryToken,
      {
        categoryId: noise.id,
        targetUnitCode: rented.code,
        body: 'PII-COMPLAINT-text',
      },
    );
    await call(w, 'POST', `/neighbours/complaints/${piiComplaint}/review`, {
      token: a.tokens.manager,
    }).expect(204);
    await idOf(
      'POST',
      `/neighbours/complaints/${piiComplaint}/notice`,
      a.tokens.manager,
      { body: 'PII-NOTICE-text' },
    );
    for (const [path, body] of [
      ['messages', 'PII-COMPLAINT-reply'],
      ['notes', 'PII-COMPLAINT-note'],
      ['unit-messages', 'PII-COMPLAINT-to-unit'],
    ])
      await idOf(
        'POST',
        `/neighbours/complaints/${piiComplaint}/${path}`,
        a.tokens.manager,
        { body },
      );
    const piiAgainst = await idOf(
      'POST',
      '/neighbour-complaints',
      neighbourToken,
      {
        categoryId: noise.id,
        targetUnitCode: unit.code,
        body: 'PII-AGAINST-text',
      },
    );
    await call(w, 'POST', `/neighbours/complaints/${piiAgainst}/review`, {
      token: a.tokens.manager,
    }).expect(204);
    const piiNotice = await idOf(
      'POST',
      `/neighbours/complaints/${piiAgainst}/notice`,
      a.tokens.manager,
      { body: 'PII-AGAINST-notice' },
    );
    await idOf(
      'POST',
      `/neighbour-notices/${piiNotice}/messages`,
      primaryToken,
      {
        body: 'PII-AGAINST-reply',
      },
    );
    const piiPost = await idOf('POST', '/neighbour-posts', primaryToken, {
      kind: 'found',
      body: 'PII-POST-body',
      place: 'PII-POST-place',
    });
    await idOf('POST', `/neighbour-posts/${piiPost}/claims`, neighbourToken, {
      note: 'PII-CLAIM-note',
    });
    const piiConversation = await idOf(
      'POST',
      `/neighbour-posts/${piiPost}/conversations`,
      neighbourToken,
      { body: 'PII-CONVERSATION-words' },
    );
    const piiLend = await idOf('POST', '/neighbour-posts', primaryToken, {
      kind: 'lend',
      body: 'PII-LEND-body',
    });
    const piiReported = await idOf(
      'POST',
      `/neighbour-posts/${piiLend}/conversations`,
      neighbourToken,
      { body: 'PII-REPORTED-words' },
    );
    const piiReport = await idOf(
      'POST',
      `/neighbour-conversations/${piiReported}/report`,
      primaryToken,
      { reasonCode: 'spam', note: 'PII-REPORT-note' },
    );
    // The club (ADR 0044): the primary's home's membership, paid for.
    const piiMembership = await idOf(
      'POST',
      '/staff/club-memberships',
      a.tokens.manager,
      {
        unitId: unit.id,
        people: [],
      },
    );
    await idOf(
      'POST',
      `/staff/club-memberships/${piiMembership}/payments`,
      a.tokens.manager,
      {
        planId: w.aClubPlanId,
        amount: '500',
        receiptNumber: `R-PII-${uniqueSuffix()}`,
        paidOn: day(0),
      },
    );
    // Finance (ADR 0046): an invoice to the primary's home, its lines in
    // the staff's words; a credit note on it.
    const piiBatch = await idOf('POST', '/staff/invoices', a.tokens.manager, {
      target: 'unit',
      unitId: unit.id,
      kind: 'maintenance',
      dueOn: day(5),
      lines: [
        {
          descriptionEn: 'Pump repair',
          descriptionAr: 'إصلاح المضخة',
          amount: '800',
        },
      ],
    });
    const piiInvoice = {
      batchId: piiBatch,
      invoiceId: (
        (
          await call(w, 'GET', '/staff/invoices', {
            token: a.tokens.manager,
            query: { batchId: piiBatch },
          }).expect(200)
        ).body as { data: { id: string }[] }
      ).data[0].id,
    };
    await idOf(
      'POST',
      `/staff/invoices/${piiInvoice.invoiceId}/credit-notes`,
      a.tokens.manager,
      { amount: '50', reasonCode: 'goodwill' },
    );
    const piiPayment = await idOf(
      'POST',
      `/staff/units/${unit.id}/payments`,
      a.tokens.manager,
      { amount: '300', method: 'cheque', reference: 'CHQ-77', paidOn: day(0) },
    );
    // Instalments (ADR 0048): a fresh invoice of the home, split in two.
    const toSplit = await idOf('POST', '/staff/invoices', a.tokens.manager, {
      target: 'unit',
      unitId: unit.id,
      kind: 'other',
      dueOn: day(5),
      lines: [
        {
          descriptionEn: 'Gate fob',
          descriptionAr: 'شريحة البوابة',
          amount: '400',
        },
      ],
    });
    const toSplitInvoice = (
      (
        await call(w, 'GET', '/staff/invoices', {
          token: a.tokens.manager,
          query: { batchId: toSplit },
        }).expect(200)
      ).body as { data: { id: string }[] }
    ).data[0].id;
    const piiInstalmentPlan = await idOf(
      'POST',
      `/staff/invoices/${toSplitInvoice}/instalment-plan`,
      a.tokens.manager,
      {
        instalments: [
          { dueOn: day(5), amount: '200' },
          { dueOn: day(35), amount: '200' },
        ],
      },
    );
    // Disputes (ADR 0048): the primary disputes the home's other invoice in
    // their own words; the staff and the primary read them.
    const piiDispute = await idOf(
      'POST',
      `/invoices/${piiInvoice.invoiceId}/disputes`,
      primaryToken,
      { reasonCode: 'service_not_provided', text: 'The pump still leaks' },
    );
    // Refunds (ADR 0048): credit on the home, paid back by the manager
    // after a step-up; staff names only.
    await w.helpers.asManager(a, () =>
      h.moduleRef.get(TenantTx).withTenantTx((tx) =>
        paymentRow(tx, {
          tenantId: a.tenantId,
          unitId: unit.id,
          recordedById: a.ids.manager,
          amount: '120',
        }),
      ),
    );
    await h.moduleRef.get(GlobalDbService).session.update({
      where: { id: sessionOf(a.tokens.manager) },
      data: { stepUpUntil: new Date(Date.now() + 600_000) },
    });
    const piiRefund = await idOf(
      'POST',
      `/staff/units/${unit.id}/refunds`,
      a.tokens.manager,
      { amount: '120', channel: 'bank_transfer', refundedOn: day(0) },
    );
    const piiPlan = await idOf(
      'POST',
      '/staff/billing-plans',
      a.tokens.manager,
      {
        nameEn: 'Service charge',
        nameAr: 'رسوم الخدمات',
        kind: 'service_charge',
        frequency: 'monthly',
        amount: '1500',
        startsOn: `${day(0).slice(0, 8)}01`,
        issueDaysBefore: 0,
        dueDaysAfterIssue: 10,
      },
    );
    await call(
      w,
      'PUT',
      `/staff/billing-plans/${piiPlan}/overrides/${unit.id}`,
      {
        token: a.tokens.manager,
        body: { amount: '900' },
      },
    ).expect(200);
    // Facilities (ADR 0044): the primary's booking of A's roomy facility.
    const piiBooking = await idOf(
      'POST',
      `/units/${unit.id}/bookings`,
      primaryToken,
      { facilityId: w.aFacilityId, startsAt: at(day(3), 21).toISOString() },
    );
    // Vehicles (ADR 0045): the primary's car on their home.
    const piiVehicle = await idOf(
      'POST',
      `/units/${unit.id}/vehicles`,
      primaryToken,
      {
        plate: 'PII 4321',
        makeAndModel: 'PII car',
        color: 'Grey',
        type: 'car',
      },
    );
    const piiViolation = await idOf(
      'POST',
      '/staff/violations',
      a.tokens.manager,
      {
        kind: 'noise',
        unitCode: unit.code,
        note: 'Loud after midnight',
        amount: '100',
        occurredOn: day(0),
      },
    );
    const piiFine = await idOf(
      'POST',
      '/staff/vehicle-fines',
      a.tokens.manager,
      {
        unitCode: unit.code,
        vehicleId: piiVehicle,
        reason: 'blocking',
        note: 'Blocked the gate',
        amount: '200',
        occurredOn: day(0),
      },
    );
    const piiParkingReport = await idOf(
      'POST',
      '/parking-reports',
      neighbourToken,
      {
        plate: 'PII 4321',
        location: 'PII ramp',
        note: 'Seen twice',
      },
    );

    // An emergency at home (ADR 0047): the primary reported it, the family
    // member was alerted.
    const piiEmergency = await idOf(
      'POST',
      '/emergencies',
      await w.tokenFor(a, primary.id, 'resident'),
      { type: 'medical', unitId: unit.id },
    );

    // A suspicious-activity report in the primary's words (ADR 0047).
    const piiPlace = await manager(() =>
      c.prisma.tenant.place.findFirstOrThrow({ where: { key: 'parking' } }),
    );
    const piiGateService = await idOf(
      'POST',
      '/security-reports',
      await w.tokenFor(a, primary.id, 'resident'),
      {
        unitId: unit.id,
        placeId: piiPlace.id,
        description: 'PII-SUSPICIOUS-words',
      },
    );

    // A works permit with a contractor worker (ADR 0049): their name to the
    // household and the management (and the guard at the gate), the last
    // four of their ID to nobody, ever.
    const piiPermit = await idOf(
      'POST',
      `/units/${unit.id}/permits/works`,
      primaryToken,
      {
        workType: 'renovation',
        startsOn: day(0),
        endsOn: day(3),
        dailyHours: { from: '09:00', to: '17:00' },
        contractorCompany: 'PII-CONTRACTOR-company',
        description: 'PII-PERMIT-words',
      },
    );
    await call(w, 'POST', `/permits/${piiPermit}/workers`, {
      token: primaryToken,
      body: {
        fullName: 'PII-CONTRACTOR-name',
        photoFileId: await fileHelpers(h).ready(
          primaryToken,
          'contractor_photo',
        ),
        idType: 'passport',
        idLast4: 'QZ7X',
      },
    }).expect(201);
    // An election of the board with the primary standing (ADR 0051): their
    // name and statement to the owners, never to anyone else.
    const piiGovernanceElection = await idOf(
      'POST',
      '/governance/elections',
      a.tokens.manager,
      {
        titleEn: 'PII-scan election',
        bodyEn: 'Three seats.',
        seats: 3,
        termMonths: 24,
        nominationsCloseAt: new Date(Date.now() + 25 * 3_600_000).toISOString(),
        votingOpensAt: new Date(Date.now() + 25 * 3_600_000).toISOString(),
        votingClosesAt: new Date(Date.now() + 49 * 3_600_000).toISOString(),
      },
    );
    await call(
      w,
      'POST',
      `/governance/elections/${piiGovernanceElection}/candidacy`,
      {
        token: primaryToken,
        body: { statement: 'PII-STATEMENT-words' },
      },
    ).expect(201);
    // An owners' poll (ADR 0051): the board's words; no one's data.
    const piiGovernancePoll = await idOf(
      'POST',
      '/governance/polls',
      a.tokens.manager,
      {
        kind: 'yes_no',
        titleEn: 'PII-scan poll',
        bodyEn: 'Whether to repaint.',
        secret: true,
        quorumPct: 50,
        thresholdPct: 50,
        closesAt: new Date(Date.now() + 48 * 3_600_000).toISOString(),
      },
    );
    // Approved: the guard sees it at the gate today.
    await call(w, 'POST', `/staff/unit-permits/${piiPermit}/approve`, {
      token: a.tokens.manager,
    }).expect(200);
    // A handover at A's gate (ADR 0050): a guard's words to the next guard
    // and the management; first names to guards, full names to the staff.
    const relief = await gateHelpers(h).guard(a);
    const ended = await c.as(a, { id: relief.id, type: 'staff' }, async () => {
      await h.moduleRef.get(ShiftsService).start({ gateId: a.gateId });
      return h.moduleRef.get(ShiftsService).end({ notes: 'Gate quiet' });
    });
    const piiHandover = (
      await manager(() =>
        c.prisma.tenant.guardHandover.findFirstOrThrow({
          where: { shiftId: ended.id },
        }),
      )
    ).id;

    // A task for A's gate, where A's guard is on shift (ADR 0050): a unit's
    // code and building at most, never anyone in it.
    const piiTask = (
      await manager(() =>
        h.moduleRef
          .get(TasksService)
          .create({ kind: 'custom', title: 'Check lights', gateId: a.gateId }),
      )
    ).id;

    /** One id for every param of the path, or each param by name. */
    type Ids = string | Record<string, string>;
    const params: Record<string, Ids> = {
      '/tickets/{id}': ticket.id,
      '/technician/tickets/{id}': ticket.id,
      '/tickets/{id}/messages': ticket.id,
      // ADR 0058: the quotes.
      '/tickets/{id}/quotes': ticket.id,
      '/maintenance/tickets/{id}/quotes': ticket.id,
      // ADR 0065: the ticket's costs and suggested quotes, staff only.
      '/maintenance/tickets/{id}/costs': ticket.id,
      '/maintenance/tickets/{id}/quote-suggestions': ticket.id,
      '/technician/tickets/{id}/quote-suggestions': ticket.id,
      '/maintenance/tickets/{id}/parts': ticket.id,
      '/technician/tickets/{id}/parts': ticket.id,
      // B's store and item: not found for everyone of A.
      '/maintenance/stores/{id}': w.bStoreId,
      '/maintenance/stock/items/{id}': w.bStockItemId,
      '/maintenance/contracts/{id}': w.bContractId,
      '/maintenance/meters/{id}': w.bMeterId,
      '/maintenance/meters/{id}/readings': w.bMeterId,
      '/technician/meters/{id}': w.bMeterId,
      '/maintenance/meters/{id}/consumption': w.bMeterId,
      '/maintenance/meter-reading-imports/{id}': w.bReadingImportId,
      '/maintenance/energy/measures/{id}': w.bMeasureId,
      '/maintenance/outages/{id}': w.bOutageId,
      // ADR 0067: B's readiness program and its item.
      '/maintenance/readiness/programs/{id}': w.bProgramId,
      '/maintenance/readiness/programs/{id}/items': w.bProgramId,
      '/maintenance/readiness/programs/{id}/contracts-due': w.bProgramId,
      '/maintenance/readiness/items/{itemId}/campaign': w.bReadinessItemId,
      '/maintenance/assets/{id}/contracts': w.bAssetId,
      '/maintenance/assets/{id}/economics': w.bAssetId,
      '/maintenance/technicians/{id}/stats': w.b.ids.technician,
      // ADR 0058: a formal notice (none here: not found).
      '/me/notices/{id}': '0192a5f0-1c2b-7d3e-8f40-0000000058e2',
      // ADR 0062: the compound's documents (none published here).
      '/compound-documents/versions/{id}':
        '0192a5f0-1c2b-7d3e-8f40-0000000062b3',
      // ADR 0062: clearances and deposits (none here: not found or empty).
      '/units/{unitId}/clearances': a.homeUnitId,
      '/clearances/{id}/certificate': '0192a5f0-1c2b-7d3e-8f40-0000000062d1',
      '/staff/clearances/{id}/certificate':
        '0192a5f0-1c2b-7d3e-8f40-0000000062d2',
      '/staff/units/{unitId}/deposits': a.homeUnitId,
      // ADR 0062: contracts (none recorded here: not found).
      '/units/{unitId}/contracts/{id}': {
        unitId: a.homeUnitId,
        id: '0192a5f0-1c2b-7d3e-8f40-0000000062c2',
      },
      '/units/{unitId}/contracts/{id}/end-options': {
        unitId: a.homeUnitId,
        id: '0192a5f0-1c2b-7d3e-8f40-0000000062c3',
      },
      '/staff/units/{unitId}/contracts': a.homeUnitId,
      // ADR 0063: moves — the home's move-in is real (the lists scan it);
      // one move by id is not found.
      '/units/{unitId}/moves': a.homeUnitId,
      '/units/{unitId}/moves/{id}': {
        unitId: a.homeUnitId,
        id: '0192a5f0-1c2b-7d3e-8f40-0000000063a2',
      },
      '/staff/moves/{id}': '0192a5f0-1c2b-7d3e-8f40-0000000063a3',
      // ADR 0063: proxies (none appointed here: empty lists).
      '/units/{unitId}/proxies': a.homeUnitId,
      '/staff/units/{unitId}/proxies': a.homeUnitId,
      // ADR 0063: a closed unit's inspections (A's home: none, empty lists).
      '/units/{unitId}/inspection-requests': a.homeUnitId,
      '/units/{unitId}/inspections': a.homeUnitId,
      // ADR 0063: works completion (none asked here: not found).
      '/permits/{id}/completion-inspections':
        '0192a5f0-1c2b-7d3e-8f40-0000000063d2',
      '/permits/{id}/completion-certificate':
        '0192a5f0-1c2b-7d3e-8f40-0000000063d3',
      '/staff/permit-inspections/{id}/certificate':
        '0192a5f0-1c2b-7d3e-8f40-0000000063d4',
      '/staff/units/{unitId}/contracts/{id}': {
        unitId: a.homeUnitId,
        id: '0192a5f0-1c2b-7d3e-8f40-0000000062c4',
      },
      // ADR 0062: a unit's vault (the owner's home; a document not found).
      '/units/{unitId}/documents': a.homeUnitId,
      '/units/{unitId}/documents/{id}': {
        unitId: a.homeUnitId,
        id: '0192a5f0-1c2b-7d3e-8f40-0000000062a7',
      },
      '/staff/units/{unitId}/documents': a.homeUnitId,
      '/staff/units/{unitId}/documents/{id}': {
        unitId: a.homeUnitId,
        id: '0192a5f0-1c2b-7d3e-8f40-0000000062a8',
      },
      // ADR 0062: proof of kinship (none here: not found).
      '/household/members/{id}/kinship-documents/{documentId}': {
        id: '0192a5f0-1c2b-7d3e-8f40-0000000062a3',
        documentId: '0192a5f0-1c2b-7d3e-8f40-0000000062a4',
      },
      '/household/invites/{id}/kinship-documents/{documentId}': {
        id: '0192a5f0-1c2b-7d3e-8f40-0000000062a5',
        documentId: '0192a5f0-1c2b-7d3e-8f40-0000000062a6',
      },
      // ADR 0062: a registrant's document (none here: not found).
      '/registrations/{id}/documents/{documentId}': {
        id: '0192a5f0-1c2b-7d3e-8f40-0000000062a1',
        documentId: '0192a5f0-1c2b-7d3e-8f40-0000000062a2',
      },
      // ADR 0058: the resident's timeline.
      '/tickets/{id}/timeline': ticket.id,
      '/technician/tickets/{id}/messages': ticket.id,
      '/maintenance/tickets/{id}/messages': ticket.id,
      '/maintenance/tickets/{id}': ticket.id,
      '/maintenance/tickets/{id}/history': ticket.id,
      '/maintenance/tickets/{id}/assignments': ticket.id,
      '/maintenance/tickets/{id}/dispatch-attempts': queued.id,
      '/maintenance/tickets/{id}/sla-events': ticket.id,
      '/tickets/{id}/visits': visitTicket.id,
      // ADR 0038: windows of free time, never anyone's.
      '/tickets/{id}/visit-slots': visitTicket.id,
      '/technician/tickets/{id}/visits': visitTicket.id,
      '/maintenance/tickets/{id}/visits': visitTicket.id,
      '/maintenance/tickets/{id}/visit-events': visitTicket.id,
      '/maintenance/units/{unitId}/reporters': unit.id,
      '/me/units/{unitId}/visits': unit.id,
      '/files/{id}': photoId,
      '/units/{id}': unit.id,
      '/units/{id}/activation': unit.id,
      '/units/{id}/household/to-review': unit.id,
      '/units/{unitId}/household': unit.id,
      '/units/{unitId}/household/minors-ready': unit.id,
      '/units/{unitId}/children': unit.id,
      '/units/{unitId}/children/pickups': unit.id,
      '/staff/security/child-alerts/{id}': childAlert.pickupId,
      '/units/{unitId}/children/{memberId}/control/escorts': {
        unitId: unit.id,
        memberId: child.id,
      },
      '/units/{unitId}/workers': unit.id,
      // ADR 0037.
      '/units/{unitId}/workers/{id}': {
        unitId: unit.id,
        id: registered.engagementId,
      },
      '/units/{unitId}/deferred-actions': unit.id,
      '/units/{unitId}/delegations': unit.id,
      '/units/{unitId}/visitor-passes': unit.id,
      // ADR 0043: the family member's pass, read by every member of the unit.
      '/visitor-passes/{id}': visit.id,
      '/units/{unitId}/gate-instructions': unit.id,
      '/units/{unitId}/standing-instructions': unit.id,
      '/gate/approval-requests/{id}': asked.id,
      '/gate/parcels/{id}': parcel.id,
      '/me/parcels/{id}': parcel.id,
      '/parcels/{id}': parcel.id,
      '/me/units/{unitId}/capabilities': unit.id,
      // ADR 0058.
      '/me/units/{unitId}/service-standing': unit.id,
      '/me/units/{unitId}/permissions': unit.id,
      '/residents/{id}': primary.id,
      '/accounts/{id}': primary.id,
      '/accounts/{id}/legal-holds': leaving.id,
      '/household/members/{id}/permissions': joined.memberId,
      '/roles/{id}': roles[0].id,
      '/erasures/{id}/scope': request.id,
      '/worker-engagements/{id}': registered.engagementId,
      '/worker-engagements/{id}/attendance': registered.engagementId,
      '/worker-engagements/{id}/wage-payments': registered.engagementId,
      '/platform/tenants/{id}': a.tenantId,
      // ADR 0036: nobody's ready export (the export suite reads a real one).
      '/me/data-exports/{id}/download': request.id,
      '/accounts/{id}/notification-preferences': primary.id,
      '/accounts/{id}/consents': primary.id,
      // Where an assisted export and a deletion request stand: no link.
      '/accounts/{id}/data-exports': primary.id,
      '/accounts/{id}/deletion-request': leaving.id,
      // ADR 0039: the primary's own request.
      '/management-requests/{id}': mgmtRequest,
      '/management-requests/{id}/messages': mgmtRequest,
      '/management/requests/{id}': mgmtRequest,
      '/management/requests/{id}/messages': mgmtRequest,
      '/management/requests/{id}/rating': mgmtRequest,
      '/management/units/{unitId}/request-authors': unit.id,
      // ADR 0040.
      '/community/announcements/{id}': piiAnnouncement,
      '/community/announcements/{id}/versions': piiAnnouncement,
      '/community/announcements/{id}/reads': piiAnnouncement,
      '/announcements/{id}': piiAnnouncement,
      '/community/events/{id}': piiEvent,
      '/community/events/{id}/attendees': piiEvent,
      '/events/{id}': piiEvent,
      '/community/polls/{id}': piiPoll,
      '/community/polls/{id}/audience': piiPoll,
      '/polls/{id}': piiPoll,
      '/suggestions/{id}': piiSuggestion,
      '/community/suggestions/{id}': piiSuggestion,
      // ADR 0042: the primary's own complaint; the notice that came to their
      // home; their post, its unreported conversation and a reported one.
      '/neighbour-complaints/{id}': piiComplaint,
      '/neighbour-complaints/{id}/messages': piiComplaint,
      '/neighbour-notices/{id}': piiNotice,
      '/neighbour-notices/{id}/messages': piiNotice,
      '/neighbour-posts/{id}': piiPost,
      '/neighbour-conversations/{id}': piiConversation,
      '/neighbour-conversations/{id}/messages': piiConversation,
      '/neighbours/complaints/{id}': piiComplaint,
      '/neighbours/complaints/{id}/messages': piiComplaint,
      '/neighbours/complaints/{id}/unit-messages': piiComplaint,
      '/neighbours/complaints/{id}/notes': piiComplaint,
      '/neighbours/posts/{id}': piiPost,
      '/neighbours/posts/{id}/claims': piiPost,
      '/neighbours/reports/{id}': piiReport,
      '/neighbours/reports/{id}/messages': piiReport,
      '/neighbours/units/{unitId}/complaint-history': unit.id,
      '/facilities/{id}': w.aFacilityId,
      '/staff/facilities/{id}': w.aFacilityId,
      '/facilities/{id}/slots': w.aFacilityId,
      '/units/{unitId}/bookings': unit.id,
      '/bookings/{id}': piiBooking,
      '/staff/bookings/{id}': piiBooking,
      '/staff/facilities/{id}/day': w.aFacilityId,
      '/staff/facilities/{id}/closures': w.aFacilityId,
      '/units/{unitId}/booking-standing': unit.id,
      '/units/{unitId}/club-membership': unit.id,
      '/staff/club/units/{unitId}/people': unit.id,
      '/staff/club-memberships/{id}': piiMembership,
      '/units/{unitId}/vehicles': unit.id,
      '/vehicles/{id}': piiVehicle,
      '/staff/vehicles/{id}': piiVehicle,
      '/units/{unitId}/parking': unit.id,
      '/units/{unitId}/visitor-parking-bookings': unit.id,
      '/units/{unitId}/vehicle-fines': unit.id,
      '/vehicle-fines/{id}': piiFine,
      '/staff/vehicle-fines/{id}': piiFine,
      '/staff/parking-reports/{id}': piiParkingReport,
      // ADR 0047: the family's phones, for those who live there only.
      '/units/{unitId}/emergency-contacts': unit.id,
      '/emergencies/{id}': piiEmergency,
      '/gate/emergencies/{id}': piiEmergency,
      '/gate-services/{id}': piiGateService,
      '/gate/gate-services/{id}': piiGateService,
      // ADR 0046: last four characters at most, never a name.
      '/platform/tenants/{id}/payment-gateway': a.tenantId,
      '/staff/invoice-batches/{id}': piiInvoice.batchId,
      '/staff/invoices/{id}': piiInvoice.invoiceId,
      '/invoices/{id}': piiInvoice.invoiceId,
      '/units/{unitId}/invoices': unit.id,
      '/staff/billing-plans/{id}': piiPlan,
      '/staff/billing-plans/{id}/overrides': piiPlan,
      '/staff/payments/{id}': piiPayment,
      '/payments/{id}': piiPayment,
      '/units/{unitId}/payments': unit.id,
      '/units/{unitId}/statement': unit.id,
      '/staff/units/{unitId}/statement': unit.id,
      // A foreign checkout: not found for everyone of A.
      '/payment-sessions/{id}': w.bPaymentSessionId,
      // ADR 0048: numbers, amounts and unit codes only.
      '/staff/instalment-plans/{id}': piiInstalmentPlan,
      '/instalment-plans/{id}': piiInstalmentPlan,
      // The opener's words to the opener and the staff; never a name.
      '/staff/invoice-disputes/{id}': piiDispute,
      '/invoice-disputes/{id}': piiDispute,
      '/invoices/{id}/disputes': piiInvoice.invoiceId,
      '/staff/refunds/{id}': piiRefund,
      // ADR 0049: the requester's and the primary's; the last four nowhere.
      '/units/{unitId}/permits': unit.id,
      '/permits/{id}': piiPermit,
      // ADR 0060: A's partner as each reader sees it; B's request and
      // complaint, not found for everyone of A.
      '/partners/{id}': w.aPartnerId,
      '/staff/partners/{id}': w.aPartnerId,
      '/partner-requests/{id}': w.bPartnerRequestId,
      '/staff/partner-requests/{id}': w.bPartnerRequestId,
      '/staff/partner-complaints/{id}': w.bComplaintIdOfPartner,
      '/staff/unit-permits/{id}': piiPermit,
      '/gate/unit-permits/{id}': piiPermit,
      '/staff/security/handovers/{id}': piiHandover,
      '/staff/security/tasks/{id}': piiTask,
      '/gate/tasks/{id}': piiTask,
      // A swap of B's: not found for everyone of A.
      '/gate/swaps/{id}': w.bSwapId,
      '/staff/security/swaps/{id}': w.bSwapId,
      // An instruction of B's: not found for everyone of A.
      '/staff/security/instructions/{id}': w.bInstructionId,
      '/gate/guard-instructions/{id}': w.bInstructionId,
      // A found item of B's: not found for everyone of A.
      '/gate/found-items/{id}': w.bFoundItemId,
      '/staff/security/found-items/{id}': w.bFoundItemId,
      // ADR 0051.
      '/governance/polls/{id}': piiGovernancePoll,
      '/staff/governance/polls/{id}': piiGovernancePoll,
      '/governance/elections/{id}': piiGovernanceElection,
      '/staff/governance/elections/{id}': piiGovernanceElection,
      // ADR 0055: a request of B's: not found for everyone of A.
      '/staff/governance/approvals/{id}': w.bApprovalId,
      '/board/approvals/{id}': w.bApprovalId,
      '/staff/finance/budgets/{id}': w.bBudgetId,
      '/staff/finance/expenses/{id}': w.bExpenseId,
      '/governance/board-appeals/{id}': w.bBoardAppealId,
      '/staff/governance/board-appeals/{id}': w.bBoardAppealId,
      '/board/appeals/{id}': w.bBoardAppealId,
      // ADR 0059: a decision appeal of B's: not found for everyone of A.
      '/decision-appeals/{id}': w.bDecisionAppealId,
      '/staff/decision-appeals/{id}': w.bDecisionAppealId,
      // B's representative and a thread written to them: not found for
      // everyone of A.
      '/me/representatives/{id}/messages': w.bRepresentativeId,
      '/me/representation/threads/{id}/messages': w.bRepresentativeThreadId,
      '/board/representatives/matters/{id}': w.bRepresentativeMatterId,
      // B's agenda proposal and published decision: not found for A.
      '/governance/agenda-proposals/{id}': w.bAgendaProposalId,
      '/board/agenda-proposals/{id}': w.bAgendaProposalId,
      '/board/publications/{id}/objections': w.bPublicationId,
      // A route and a run of B's: not found for everyone of A.
      '/staff/security/patrols/routes/{id}': w.bRouteId,
      '/staff/security/patrols/runs/{id}': w.bRunId,
      '/gate/patrols/runs/{id}': w.bRunId,
      '/gate/patrols/runs/{id}/track': w.bRunId,
      '/staff/security/patrols/runs/{id}/track': w.bRunId,
      // ADR 0053: B's lockdown, not found for everyone of A.
      '/staff/security/lockdowns/{id}': w.bLockdownId,
      // B's blocklist entry, not found for everyone of A.
      '/staff/security/blocklist/{id}': w.bBlocklistEntryId,
      '/staff/security/blocklist/{id}/matches': w.bBlocklistEntryId,
      // B's incident, not found for everyone of A.
      '/gate/incidents/{id}': w.bIncidentId,
      '/staff/security/incidents/{id}': w.bIncidentId,
      // ADR 0053: A's violation, the unit's and the office's.
      '/units/{unitId}/violations': unit.id,
      '/violations/{id}': piiViolation,
      '/staff/violations/{id}': piiViolation,
      // ADR 0056: A's field exception, the gate's and the deciders'.
      '/gate/field-exceptions/{id}': piiException.id,
      '/staff/gate/field-exceptions/{id}': piiException.id,
      // B's entry, incident and run: not found for everyone of A.
      '/gate/entries/{id}/photo': w.bEntryId,
      '/gate/incidents/{id}/evidence': w.bIncidentId,
      '/staff/security/incidents/{id}/evidence': w.bIncidentId,
      '/gate/incidents/{id}/signatures': w.bIncidentId,
      '/staff/security/incidents/{id}/signatures': w.bIncidentId,
      '/staff/security/patrols/runs/{id}/geofence-exits': w.bRunId,
      // ADR 0057: B's device, not found for everyone of A.
      '/staff/gate/devices/{id}': w.bGateDeviceId,
      '/staff/gate/offline/flags/{id}': w.bOfflineFlagId,
      '/staff/gate/offline/batches/{id}': w.bOfflineBatchId,
      // ADR 0064: the register's places, never a person's.
      '/maintenance/areas/{id}': w.bCommonAreaId,
      '/maintenance/assets/{id}': w.bAssetId,
      '/maintenance/assets/{id}/events': w.bAssetId,
      '/maintenance/assets/{id}/impact': w.bAssetId,
      '/maintenance/asset-imports/{id}': w.bAssetImportId,
      '/maintenance/checklists/{id}': w.bChecklistId,
      // ADR 0064: a ticket's checklist (none on this one: not found).
      '/technician/tickets/{id}/checklist': ticket.id,
      '/maintenance/tickets/{id}/checklist': ticket.id,
      '/maintenance/plans/{id}': w.bPlanId,
      '/maintenance/plans/{id}/occurrences': w.bPlanId,
      '/maintenance/plans/{id}/events': w.bPlanId,
      '/maintenance/inspection-rounds/{id}': w.bRoundId,
      '/maintenance/inspections/{id}': w.bInspectionId,
      '/technician/inspections/{id}': w.bInspectionId,
      '/technician/assets/{id}': w.bAssetId,
    };
    /**
     * The landlord and the ender ask about their own unit: the one rented
     * out, the one they left — its unit routes, the ender's old ticket, the
     * household's member and worker.
     */
    const rentedParams: Record<string, Ids> = {
      ...Object.fromEntries(
        Object.keys(params)
          .filter((path) => /\/units\/\{(id|unitId)\}/.test(path))
          .map((path) => [path, rented.id]),
      ),
      '/tickets/{id}': oldTicket.id,
      '/tickets/{id}/messages': oldTicket.id,
      '/tickets/{id}/visits': oldTicket.id,
      '/tickets/{id}/quotes': oldTicket.id,
      '/tickets/{id}/timeline': oldTicket.id,
      '/household/members/{id}/permissions': rentedJoined.memberId,
      '/worker-engagements/{id}': rentedEngagement.engagementId,
      '/worker-engagements/{id}/attendance': rentedEngagement.engagementId,
      '/worker-engagements/{id}/wage-payments': rentedEngagement.engagementId,
      '/units/{unitId}/workers/{id}': {
        unitId: rented.id,
        id: rentedEngagement.engagementId,
      },
    };
    const paramsOf = (name: string) =>
      name === 'landlord' || name === 'ender'
        ? { ...params, ...rentedParams }
        : params;
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
      // ADR 0037: lives in the home, sees its workers, never a wage.
      plainMember: {
        token: await w.tokenFor(a, plainMember.accountId, 'family'),
        self: plainMember.accountId,
        isManager: false,
      },
    };

    const idsFor = (name: string, path: string): Record<string, string> => {
      const given = paramsOf(name)[path];
      return typeof given === 'string'
        ? Object.fromEntries(paramNames(path).map((n) => [n, given]))
        : given;
    };

    /** Routes that answer only with a query (ADR 0048: a period). */
    const period = { from: day(-30), to: day(0) };
    const queries: Record<string, Record<string, string>> = {
      '/staff/finance/ledger': period,
      '/staff/finance/ledger/export': period,
      '/staff/finance/reports/collections': period,
      '/staff/finance/reports/collections/export': period,
      // A page long enough for every notice the fixtures leave.
      '/me/notifications': { limit: '100' },
      // ADR 0049: the guard's lookup takes a unit's code or a reference.
      '/gate/unit-permits': { unitCode: unit.code },
      // ADR 0058: the resident's search, by a reference every compound has.
      '/me/search': { q: 'MT-1' },
    };

    const leaks: string[] = [];
    const seen = new Map<string, string>();
    for (const [name, persona] of Object.entries(personas)) {
      for (const r of gets) {
        const path = paramNames(r.path).length
          ? fill(r.path, idsFor(name, r.path))
          : r.path;
        const isPlatformRoute = r.auth === 'platform';
        if ((name === 'platform') !== isPlatformRoute && r.auth !== 'public')
          continue;
        const res = await call(w, 'GET', path, {
          token: r.auth === 'public' ? undefined : persona.token,
          query: queries[r.path],
        });
        const text = res.text ?? '';
        seen.set(`${name} ${r.path}`, text);
        const found = (s: string) => s && text.includes(s);
        // ADR 0043: a pass's code is shown again to its host and the
        // unit's primary, on the pass's own detail; nowhere else.
        const passCodeReader =
          r.path === '/visitor-passes/{id}' &&
          (name === 'family' || name === 'resident');
        for (const s of secrets)
          if (found(s) && !(passCodeReader && s === visit.code))
            leaks.push(`${name} ${r.path}: secret ${s}`);
        // ADR 0053: the blocklist's names and faces, only where it is read.
        const blocklistReader =
          (name === 'guard' && r.path === '/gate/blocklist') ||
          (name === 'manager' &&
            r.path.startsWith('/staff/security/blocklist'));
        if (
          !blocklistReader &&
          (found('PII-BLOCKLISTED person') || found(blockedFaceKey))
        )
          leaks.push(`${name} ${r.path}: a blocklisted person`);
        if (found('PII-NOTE-blocklist') && name !== 'manager')
          leaks.push(`${name} ${r.path}: the blocklist's note`);
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
        // The household (ADR 0016, 0020): a landlord never sees it, and the
        // ender sees nothing of it after leaving (ADR 0021): no name, first
        // name, phone or email of anyone who lives in the rented unit. The
        // one exception is ADR 0032's: the ender's own old ticket's thread,
        // up to the end, names its senders by first name.
        if (name === 'landlord' || name === 'ender') {
          const exempt =
            name === 'ender' && r.path === '/tickets/{id}/messages'
              ? first(tenant.fullName)
              : '';
          const theirs =
            name === 'landlord' ? [...rentedHousehold, ender] : rentedHousehold;
          for (const p of theirs)
            for (const [what, v] of [
              ['name', p.fullName ?? ''],
              ['first name', first(p.fullName)],
              ['phone', p.phone],
              ['email', p.email],
            ] as const)
              if (v !== exempt && found(v))
                leaks.push(`${name} ${r.path}: a household ${what}`);
          // What the household wrote after the end, wherever it would show.
          if (found('PII-THREAD-after'))
            leaks.push(`${name} ${r.path}: a message after the end`);
          if (name === 'landlord' && found('PII-THREAD-before'))
            leaks.push(`${name} ${r.path}: the tenant's message`);
        }
        // Ticket text (ADR 0032): descriptions, the common-area label, the
        // thread, internal notes and feedback are for those who see the
        // ticket: never a guard, a landlord, someone who left, another
        // technician or the platform. Nobody but the reporter and dispatch
        // sees the common-area ticket.
        if (
          [
            'guard',
            'landlord',
            'ender',
            'otherTechnician',
            'platform',
          ].includes(name)
        )
          for (const s of [
            'PII-TICKET-description',
            'PII-QUEUED-description',
            'PII-VISIT-description',
            'PII-AREA-description',
            'PII-AREA-text',
            'PII-MESSAGE-family',
            'PII-MESSAGE-technician',
            'PII-INTERNAL-note',
            'PII-FEEDBACK-comment',
          ])
            if (found(s)) leaks.push(`${name} ${r.path}: ${s}`);
        // A candidate's statement (ADR 0051): the owners' and the manager's.
        if (
          !['manager', 'resident', 'landlord'].includes(name) &&
          found('PII-STATEMENT-words')
        )
          leaks.push(`${name} ${r.path}: a candidate's statement`);
        if (name === 'family' || name === 'technician')
          for (const s of ['PII-AREA-description', 'PII-AREA-text'])
            if (found(s)) leaks.push(`${name} ${r.path}: ${s}`);
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
        // Wages (ADR 0037): the employer side's and payroll's only. Never
        // a landlord, a guard, a technician, someone who left, or a member
        // of the household who does not manage its workers.
        if (
          [
            'landlord',
            'guard',
            'technician',
            'otherTechnician',
            'ender',
            'family',
            'plainMember',
          ].includes(name)
        )
          for (const s of [
            '"monthlyWage"',
            '"lastPaidPeriod"',
            ...Object.values(WAGE),
            ...Object.values(PAID),
          ])
            if (found(s)) leaks.push(`${name} ${r.path}: wage ${s}`);
        // Never in the audit trail, whoever reads it. (The account consents
        // of ADR 0036 are audited by name, `consent.granted` and
        // `consent.revoked`: they say nothing about a visit.)
        if (r.path.includes('audit')) {
          const trail = text.replace(/"consent\.(granted|revoked)"/g, '');
          for (const s of [...windowMarks, 'absence', 'receiver', 'consent'])
            if (trail.includes(s)) leaks.push(`${name} ${r.path}: audit ${s}`);
        }
        // Requests to the management (ADR 0039). A request is its author's
        // alone on the resident side: its words reach the author and the
        // staff (the manager here, whose inbox also carries a preview of
        // the first message) and nobody else — not the household, a
        // landlord, a guard, a technician or the platform. A staff note
        // reaches the staff only. Nothing anyone typed is in the audit
        // trail or in a notification, whoever reads it.
        const requestWords = [
          'PII-REQUEST-text',
          'PII-REQUEST-reply',
          'PII-REQUEST-comment',
        ];
        if (name !== 'manager') {
          if (found('PII-REQUEST-note'))
            leaks.push(`${name} ${r.path}: a staff note`);
          if (name !== 'resident')
            for (const s of requestWords)
              if (found(s)) leaks.push(`${name} ${r.path}: ${s}`);
          if (name !== 'family' && found('PII-FAMILY-REQUEST-text'))
            leaks.push(`${name} ${r.path}: a family member's request`);
          if (found('"preview"')) leaks.push(`${name} ${r.path}: a preview`);
        }
        if (r.path.includes('audit') || r.path.includes('notifications'))
          for (const s of [
            ...requestWords,
            'PII-REQUEST-note',
            'PII-FAMILY-REQUEST-text',
          ])
            if (found(s)) leaks.push(`${name} ${r.path}: free text ${s}`);
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
        // Permits (ADR 0049): a contractor's name to the unit's primary who
        // asked, the management and the guard (who matches their face); the
        // last four of their ID to nobody, ever; what the resident wrote to
        // the primary and the management (the guard sees the company only).
        if (found('QZ7X')) leaks.push(`${name} ${r.path}: an ID's last four`);
        if (
          !['resident', 'manager', 'guard'].includes(name) &&
          found('PII-CONTRACTOR-name')
        )
          leaks.push(`${name} ${r.path}: a contractor's name`);
        if (
          !['resident', 'manager'].includes(name) &&
          found('PII-PERMIT-words')
        )
          leaks.push(`${name} ${r.path}: a permit's description`);
        // A unit's emergency contacts (ADR 0047): the people who live there
        // see each other's phones; nobody else's, and nobody else sees them.
        const sameHome =
          r.path === '/units/{unitId}/emergency-contacts' &&
          ['resident', 'family', 'plainMember'].includes(name)
            ? [primary, family]
            : [];
        if (!persona.isManager) {
          for (const p of others) {
            if (found(p.phone) && !sameHome.includes(p))
              leaks.push(`${name} ${r.path}: phone`);
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
    // And the guard did see the contractor, on the permit at the gate.
    expect(seen.get('guard /gate/unit-permits/{id}')).toContain(
      'PII-CONTRACTOR-name',
    );

    // Community life (ADR 0040). A suggestion's words are its author's and
    // the staff's: nobody else reads them anywhere, and the board never
    // shows them, the author or the unit, to anyone.
    const communityLeaks: string[] = [];
    for (const [key, text] of seen) {
      const [name, path] = key.split(' ');
      const board = path.startsWith('/suggestion-board');
      if (
        text.includes('PII-SUGGESTION-text') &&
        (board || (name !== 'resident' && name !== 'manager'))
      )
        communityLeaks.push(`${key}: the suggestion's words`);
      if (
        text.includes('PII-SUGGESTION-answer') &&
        (board || (name !== 'resident' && name !== 'manager'))
      )
        communityLeaks.push(`${key}: the staff's answer to the author`);
      if (board && (text.includes(primary.id) || text.includes(unit.id)))
        communityLeaks.push(`${key}: the suggestion's author or unit`);
      // Who is coming to an event is the staff's list: a resident's view of
      // an event names nobody.
      if (
        (path === '/events' || path === '/events/{id}') &&
        primary.fullName &&
        text.includes(primary.fullName)
      )
        communityLeaks.push(`${key}: an attendee's name`);
      if (path === '/me/daily-brief' && name !== 'resident')
        for (const s of [primary.id, 'PII-SUGGESTION', 'PII-REQUEST'])
          if (text.includes(s)) communityLeaks.push(`${key}: ${s}`);
    }
    expect(communityLeaks).toEqual([]);
    // Positively: the scan saw each where it belongs.
    expect(seen.get('resident /suggestions/{id}') ?? '').toContain(
      'PII-SUGGESTION-text',
    );
    expect(seen.get('manager /community/suggestions/{id}') ?? '').toContain(
      'PII-SUGGESTION-answer',
    );
    for (const name of ['resident', 'family', 'landlord'])
      expect(seen.get(`${name} /suggestion-board`) ?? '').toContain(
        'PII-SUMMARY-title',
      );
    expect(seen.get('family /suggestion-board/done') ?? '').toContain(
      'PII-DONE-note',
    );
    expect(seen.get('family /announcements/{id}') ?? '').toContain(
      'PII-ANNOUNCEMENT-body',
    );
    expect(
      seen.get('manager /community/events/{id}/attendees') ?? '',
    ).toContain(primary.id);
    expect(seen.get('family /events/{id}') ?? '').toContain('"seats":2');
    // The family member's own list of suggestions is empty: not the primary's.
    expect(seen.get('family /suggestions') ?? '').not.toContain(piiSuggestion);

    // Neighbours (ADR 0042). A complaint's words are its author's and the
    // staff's; a notice and the unit's thread are the unit's and the
    // staff's; a staff note is the staff's alone; a conversation is its two
    // sides' and, only through a report, the staff's.
    const neighbourLeaks: string[] = [];
    const tenantFirst = (tenant.fullName ?? '').split(' ')[0];
    for (const [key, text] of seen) {
      const [name, path] = key.split(' ');
      const staff = name === 'manager';
      const author = name === 'resident';
      const mine = (words: string[], allowed: boolean, what: string) => {
        if (!allowed)
          for (const word of words)
            if (text.includes(word)) neighbourLeaks.push(`${key}: ${what}`);
      };
      mine(
        ['PII-COMPLAINT-text', 'PII-COMPLAINT-reply'],
        staff || (author && path.startsWith('/neighbour-complaints')),
        "the complaint's thread",
      );
      mine(['PII-COMPLAINT-note'], staff, 'a staff note');
      // The other unit's notice and thread: never the complainant's.
      mine(
        ['PII-NOTICE-text', 'PII-COMPLAINT-to-unit'],
        staff,
        "the unit's notice",
      );
      // The complaint against the primary's home: its words are never theirs.
      mine(['PII-AGAINST-text'], staff, 'the complaint behind a notice');
      mine(
        ['PII-AGAINST-notice', 'PII-AGAINST-reply'],
        staff || (author && path.startsWith('/neighbour-notices')),
        "a notice's thread",
      );
      mine(['PII-CLAIM-note'], staff, "a claimant's note");
      mine(
        ['PII-CONVERSATION-words'],
        author && path.startsWith('/neighbour-conversations'),
        'an unreported conversation',
      );
      mine(
        ['PII-REPORTED-words'],
        (staff && path === '/neighbours/reports/{id}/messages') ||
          (author && path.startsWith('/neighbour-conversations')),
        'a reported conversation outside its case',
      );
      mine(['PII-REPORT-note'], staff, "a reporter's note");
      // What the unit complained about reads never names the complaint or
      // who made it; a board and a conversation never name the other side.
      if (
        path.startsWith('/neighbour-notices') ||
        path.startsWith('/neighbour-posts') ||
        path.startsWith('/neighbour-conversations') ||
        path === '/neighbour-claims' ||
        path === '/neighbour-blocks'
      )
        for (const secret of [
          tenant.id,
          tenant.fullName,
          piiAgainst,
          ...(author ? [] : [primary.id, primary.fullName]),
        ])
          if (secret && text.includes(secret))
            neighbourLeaks.push(`${key}: who is behind it`);
      // The staff's counts against a unit and an author never reach a resident.
      if (!staff)
        for (const word of ['unitHistory', 'authorPattern', 'againstUnit'])
          if (text.includes(word)) neighbourLeaks.push(`${key}: ${word}`);
    }
    expect(neighbourLeaks).toEqual([]);
    expect(tenantFirst).not.toBe('');
    // Positively: the scan saw each where it belongs.
    const residentSaw = (path: string) => seen.get(`resident ${path}`) ?? '';
    const managerSaw = (path: string) => seen.get(`manager ${path}`) ?? '';
    expect(residentSaw('/neighbour-complaints/{id}/messages')).toContain(
      'PII-COMPLAINT-reply',
    );
    expect(residentSaw('/neighbour-notices/{id}')).toContain(
      'PII-AGAINST-notice',
    );
    expect(residentSaw('/neighbour-notices/{id}/messages')).toContain(
      'PII-AGAINST-reply',
    );
    expect(residentSaw('/neighbour-conversations/{id}/messages')).toContain(
      'PII-CONVERSATION-words',
    );
    expect(managerSaw('/neighbours/complaints/{id}/notes')).toContain(
      'PII-COMPLAINT-note',
    );
    expect(managerSaw('/neighbours/complaints/{id}/unit-messages')).toContain(
      'PII-COMPLAINT-to-unit',
    );
    expect(managerSaw('/neighbours/complaints/{id}')).toContain(
      'PII-NOTICE-text',
    );
    expect(managerSaw('/neighbours/posts/{id}/claims')).toContain(
      'PII-CLAIM-note',
    );
    expect(managerSaw('/neighbours/reports/{id}/messages')).toContain(
      'PII-REPORTED-words',
    );
    expect(managerSaw('/neighbours/reports/{id}')).toContain('PII-REPORT-note');
    // Everyone on the board reads the post; nobody but its author who posted it.
    for (const name of ['landlord', 'family', 'plainMember'])
      expect(seen.get(`${name} /neighbour-posts/{id}`) ?? '').toContain(
        'PII-POST-body',
      );
    // The family member has none of the primary's: not their complaint, not
    // the home's notice (they hold no delegation), not their conversation.
    for (const path of [
      '/neighbour-complaints',
      '/neighbour-notices',
      '/neighbour-conversations',
    ])
      expect(seen.get(`family ${path}`) ?? '').toBe(
        '{"data":[],"nextCursor":null}',
      );

    // Requests, positively: the scan saw the words where they belong.
    const asResident = (path: string) => seen.get(`resident ${path}`) ?? '';
    const asStaff = (path: string) => seen.get(`manager ${path}`) ?? '';
    expect(asResident('/management-requests/{id}/messages')).toContain(
      'PII-REQUEST-reply',
    );
    expect(asResident('/management-requests/{id}')).toContain(
      'PII-REQUEST-comment',
    );
    expect(asStaff('/management/requests/{id}/messages')).toContain(
      'PII-REQUEST-note',
    );
    // The staff inbox item carries the preview; no resident list does.
    expect(asStaff('/management/requests')).toContain(
      '"preview":"PII-REQUEST-text"',
    );
    expect(asStaff('/management/requests/{id}/rating')).toContain(
      'PII-REQUEST-comment',
    );
    // The family member's list is their own request, and not the primary's.
    expect(seen.get('family /management-requests') ?? '').toContain(
      '"MR-000002"',
    );
    expect(seen.get('family /management-requests') ?? '').not.toContain(
      mgmtRequest,
    );

    // Wages, positively: the plain member reads the home's worker without
    // the wage, while the primary and the manager read what was hidden.
    expect(seen.get('plainMember /units/{unitId}/workers')).toContain(
      registered.engagementId,
    );
    expect(seen.get('plainMember /units/{unitId}/workers/{id}')).toContain(
      registered.engagementId,
    );
    for (const path of [
      '/units/{unitId}/workers',
      '/units/{unitId}/workers/{id}',
    ])
      expect(seen.get(`resident ${path}`)).toContain(
        `"monthlyWage":"${WAGE.home}"`,
      );
    expect(seen.get('resident /units/{unitId}/workers/{id}')).toContain(
      `"lastPaidPeriod":"${wageMonth}"`,
    );
    for (const name of ['resident', 'manager'])
      expect(
        seen.get(`${name} /worker-engagements/{id}/wage-payments`),
      ).toContain(`"amount":"${PAID.home}"`);
    // The managers who review workers read the wage in their own views,
    // the list and the detail; nobody else reaches either.
    for (const path of ['/worker-engagements', '/worker-engagements/{id}'])
      expect(seen.get(`manager ${path}`)).toContain(
        `"monthlyWage":"${WAGE.home}"`,
      );

    // The landlord and the ender, positively: they asked about their own
    // unit and were refused or answered without the household; the ender
    // reads its old thread up to the end, the tenant's first name included;
    // and the household is really there for the tenant who lives with it.
    expect(seen.get('landlord /units/{id}')).toContain(
      `"code":"${rented.code}"`,
    );
    for (const name of ['landlord', 'ender'])
      expect(seen.get(`${name} /me/units/{unitId}/visits`)).toContain(
        'VISITS_NOT_ALLOWED',
      );
    expect(seen.get('ender /tickets/{id}/visits')).toContain(
      'TICKETS_NOT_ALLOWED',
    );
    expect(seen.get('ender /tickets/{id}')).toContain('PII-OLD-description');
    const enderThread = seen.get('ender /tickets/{id}/messages')!;
    expect(enderThread).toContain('PII-THREAD-before');
    expect(enderThread).toContain(`"firstName":"${first(tenant.fullName)}"`);
    const tenantToken = await w.tokenFor(a, tenant.id, 'resident');
    const asLiving = async (path: string) =>
      (await call(w, 'GET', path, { token: tenantToken }).expect(200)).text;
    const members = await asLiving(`/units/${rented.id}/household`);
    for (const p of [rentedFamily, minor])
      expect(members).toContain(p.fullName);
    expect(await asLiving(`/units/${rented.id}/workers`)).toContain(
      rentedWorker.fullName,
    );
    const livingVisits = await asLiving(`/tickets/${oldTicket.id}/visits`);
    for (const p of [coTenant, rentedWorker])
      expect(livingVisits).toContain(`"firstName":"${first(p.fullName)}"`);
    expect(await asLiving(`/tickets/${oldTicket.id}/messages`)).toContain(
      'PII-THREAD-after',
    );

    // The reporter's phone under consent (ADR 0036): every persona reads
    // the three ticket audiences of each ticket. Exactly one read may carry
    // a reporter's phone: the assigned technician's detail of the primary's
    // open ticket. Not the family member's closed ticket, not the ticket of
    // someone who left, not dispatch, not residents, not another technician.
    const phoneReads: string[] = [];
    const tickets = {
      open: visitTicket.id,
      closed: ticket.id,
      left: oldTicket.id,
    };
    const reporterPhones = [primary.phone, family.phone, ender.phone];
    for (const [name, persona] of Object.entries(personas)) {
      if (name === 'platform') continue;
      for (const [which, id] of Object.entries(tickets))
        for (const path of [
          `/technician/tickets/${id}`,
          `/maintenance/tickets/${id}`,
          `/tickets/${id}`,
        ]) {
          const res = await call(w, 'GET', path, { token: persona.token });
          for (const phone of reporterPhones)
            if ((res.text ?? '').includes(phone))
              phoneReads.push(`${name} ${which} ${path.split('/')[1]}`);
        }
    }
    expect(phoneReads).toEqual(['technician open technician']);
    const openDetail = await call(
      w,
      'GET',
      `/technician/tickets/${visitTicket.id}`,
      {
        token: a.tokens.technician,
      },
    ).expect(200);
    expect((openDetail.body as { reporterPhone: string }).reporterPhone).toBe(
      primary.phone,
    );

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
        'plainMember /me/parcels/{id}',
        'plainMember /me/parcels',
      ]),
    ]);
    // A child's photo (ADR 0054): the household adults' list of its children.
    fileViews.push([
      childPhotoKey,
      new Set([
        'resident /units/{unitId}/children',
        'family /units/{unitId}/children',
        'plainMember /units/{unitId}/children',
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

    // A child's name (ADR 0054): the household's own views, and the reads
    // that showed a household's minors before (the management's household
    // read, ADR 0016/0021; the club's people, ADR 0044). No view of R9's
    // outside the household carries it.
    const childNameViews = new Set([
      'resident /units/{unitId}/household',
      // The new primary's members to review (ADR 0021): the household's own.
      'resident /units/{id}/household/to-review',
      'family /units/{unitId}/household',
      'plainMember /units/{unitId}/household',
      'manager /units/{unitId}/household',
      'manager /staff/club/units/{unitId}/people',
      'resident /units/{unitId}/children',
      'family /units/{unitId}/children',
      'plainMember /units/{unitId}/children',
    ]);
    for (const [key, text] of seen)
      if (!childNameViews.has(key) && text.includes(childName))
        leaks.push(`${key}: a child's name`);
    expect(seen.get('resident /units/{unitId}/children')).toContain(childName);
    // The pickup's record: the household's list, and the keepers' alert,
    // which never names the child (the name rule above holds for both).
    expect(seen.get('resident /units/{unitId}/children/pickups')).toContain(
      childAlert.pickupId,
    );
    expect(seen.get('manager /staff/security/child-alerts/{id}')).toContain(
      childAlert.pickupId,
    );
    expect(seen.get('manager /staff/security/child-alerts')).toContain(
      childAlert.pickupId,
    );
    // An outside escort's name and phone (ADR 0054): the household's list of
    // the child's escorts, nothing else.
    const escortViews = new Set([
      'resident /units/{unitId}/children/{memberId}/control/escorts',
      'family /units/{unitId}/children/{memberId}/control/escorts',
      'plainMember /units/{unitId}/children/{memberId}/control/escorts',
    ]);
    for (const [key, text] of seen)
      if (
        !escortViews.has(key) &&
        (text.includes(escortName) || text.includes(escortPhone))
      )
        leaks.push(`${key}: an escort's name or phone`);
    for (const key of escortViews) {
      expect(seen.get(key)).toContain(escortName);
      expect(seen.get(key)).toContain(escortPhone);
    }

    // The label's name and the pickup code (ADR 0035): the unit's residents
    // alone, never the guard, the manager, a landlord or anyone else.
    const parcelViews = new Set([
      'resident /me/parcels',
      'resident /me/parcels/{id}',
      'family /me/parcels',
      'family /me/parcels/{id}',
      // The plain member lives in the unit too (ADR 0037's persona).
      'plainMember /me/parcels',
      'plainMember /me/parcels/{id}',
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
    const hostViews = new Set([
      'family /units/{unitId}/visitor-passes',
      'family /visitor-passes/{id}',
    ]);
    for (const [key, text] of seen) {
      if (hostViews.has(key)) continue;
      if (text.includes('PII-VISITOR-name')) leaks.push(`${key}: visitor name`);
    }
    // A standing instruction: the unit's inviters, and the guard on a
    // waiting request for the unit (ADR 0043).
    const instructionReaders = new Set([
      'resident /units/{unitId}/standing-instructions',
      'family /units/{unitId}/standing-instructions',
      'plainMember /units/{unitId}/standing-instructions',
      'guard /gate/approval-requests/{id}',
    ]);
    for (const [key, text] of seen)
      if (!instructionReaders.has(key) && text.includes('PII-INSTRUCTION-text'))
        leaks.push(`${key}: standing instruction`);
    // (The guard's positive case is the standing-instructions suite's: the
    // request here may have timed out by the time the scan reads it.)
    expect(
      seen.get('resident /units/{unitId}/standing-instructions'),
    ).toContain('PII-INSTRUCTION-text');
    // The household's request list and its own notifications about it.
    const household = new Set([
      'resident /me/gate-requests',
      'family /me/gate-requests',
      'resident /me/notifications',
      'family /me/notifications',
      // The plain member is an adult of the household too.
      'plainMember /me/gate-requests',
      'plainMember /me/notifications',
    ]);
    for (const [key, text] of seen) {
      if (!household.has(key) && text.includes('PII-ASKED-name'))
        leaks.push(`${key}: asked visitor name`);
    }
    // A field exception's visitor (ADR 0056): the deciders' inbox only.
    const exceptionReaders = new Set([
      'manager /staff/gate/field-exceptions',
      'manager /staff/gate/field-exceptions/{id}',
    ]);
    for (const [key, text] of seen)
      if (!exceptionReaders.has(key) && text.includes('PII-EXCEPTION-name'))
        leaks.push(`${key}: a field exception's visitor`);
    expect(leaks).toEqual([]);
    for (const key of household)
      expect(seen.get(key)).toContain('PII-ASKED-name');
    // (The list's positive case is the exceptions suite's: the scan may
    // read it after the exception expired out of the pending filter.)
    expect(seen.get('manager /staff/gate/field-exceptions/{id}')).toContain(
      'PII-EXCEPTION-name',
    );
    expect(seen.get('guard /gate/field-exceptions/{id}')).toContain(
      piiException.id,
    );
    for (const key of hostViews)
      expect(seen.get(key)).toContain('PII-VISITOR-name');
    // The pass's code, again, to its host and the primary only (ADR 0043).
    for (const key of ['family', 'resident'])
      expect(seen.get(`${key} /visitor-passes/{id}`)).toContain(visit.code!);
    expect(seen.get('plainMember /visitor-passes/{id}')).toContain(visit.id);
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

    // The common-area ticket: its reporter's list, and dispatch's.
    expect(seen.get('resident /tickets')).toContain('PII-AREA-text');
    expect(seen.get('manager /maintenance/tickets')).toContain('PII-AREA-text');

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
    expect(seen.get('resident /units/{unitId}/emergency-contacts')).toContain(
      family.phone,
    );
    expect(seen.get('family /units/{unitId}/emergency-contacts')).toContain(
      primary.phone,
    );
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
    expect(publicReads).toEqual([
      // ADR 0063: a works certificate's check shows the compound, the
      // number, the unit's code and the day, never a person
      // (test/permits/works-completion).
      '/public/works-certificates/lookup',
      // ADR 0062: a clearance check shows the compound, the number, the
      // unit's code and the dates, never a person or an id
      // (test/finance/clearances-deposits).
      '/public/clearances/lookup',
      '/public/visitor-passes/lookup',
      '/public/receipts/lookup',
      // ADR 0054: an outside escort's page names nobody (test/children/escorts).
      '/public/child-pickups/lookup',
      // ADR 0060: a partner's desk shows a unit's code, a first name, the
      // window, the note and the lines while the consent holds, never a
      // phone, a full name or an id (test/partners/requests, privacy).
      '/public/partner-desk/lookup',
    ]);
    const ids = [...people.map((p) => p.id), ...Object.values(a.ids)].filter(
      Boolean,
    );
    // Whoever holds a receipt's link (ADR 0046): the compound, the number,
    // the amount, the day and the status — no person, no id, no unit.
    const receiptCode = (
      (
        await call(w, 'GET', `/staff/payments/${piiPayment}`, {
          token: a.tokens.manager,
        }).expect(200)
      ).body as { receiptCode: string }
    ).receiptCode;
    const receipt = await call(w, 'POST', '/public/receipts/lookup', {
      body: { code: receiptCode },
    }).expect(200);
    expect(Object.keys(receipt.body as object).sort()).toEqual([
      'amount',
      'compoundName',
      'currency',
      'paidOn',
      'receiptNumber',
      'status',
    ]);
    for (const p of people)
      for (const v of [p.fullName ?? '', p.phone, p.email, p.doc])
        if (v && receipt.text.includes(v))
          leaks.push(`public /public/receipts/lookup: a person's data`);
    for (const id of [...ids, unit.id])
      if (receipt.text.includes(id))
        leaks.push(`public /public/receipts/lookup: an id`);
    for (const [host, issued] of [
      ['family', visit],
      ['primary', primaryVisit],
    ] as const) {
      for (const path of ['/public/visitor-passes/lookup']) {
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
    // One test walks every GET as every persona: longer than the default.
  }, 120_000);
});
