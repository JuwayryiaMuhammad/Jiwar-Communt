import { HouseholdsService } from '../../src/community/households/households.service';
import { RegistrationService } from '../../src/community/residents/registration.service';
import { WorkersService } from '../../src/community/workers/workers.service';
import { RolesService } from '../../src/core/access/roles.service';
import { AccountDeletionService } from '../../src/core/accounts/account-deletion.service';
import { VisitorPassesService } from '../../src/gate/visitors/visitor-passes.service';
import { ApprovalsService } from '../../src/gate/approvals/approvals.service';
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
    const registered = await asPrimary(() =>
      workers.register(unit.id, {
        fullName: wp.fullName,
        idDocumentType: 'national_id',
        idDocumentNumber: wp.idDocumentNumber,
        phone: wp.phone,
        capacity: 'live_in',
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
    const people = [primary, landlord, tenant, family, leaving, ender, worker];
    const secrets = [
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

    const params: Record<string, string> = {
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
  });
});
