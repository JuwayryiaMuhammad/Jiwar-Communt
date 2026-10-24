import type { Response } from 'supertest';
import { WorkersService } from '../../src/community/workers/workers.service';
import { AccountsService } from '../../src/core/accounts/accounts.service';
import type { Compound } from './community';
import { aroundTheClock } from './compound-clock';
import { nationalIdFor, uniqueSuffix } from './fixtures';
import { uniqueEmail, uniquePhone, type HttpHarness } from './http-app';
import { permitHelpers } from './permits';
import type { Who } from './safety';
import { plate } from './vehicles';

export interface DecisionAppealBody {
  id: string;
  reference: string;
  kind: string;
  subjectId: string;
  unitCode: string;
  status: 'pending' | 'upheld' | 'overturned' | 'withdrawn';
  decisionAt: string;
  lodgedAt: string;
  withdrawnAt: string | null;
  decision: {
    outcome: 'upheld' | 'overturned';
    decidedAt: string;
    rationale: string;
    decidedBy: { roleKey: string; roleName: string | null };
    effect: 'applied' | 'follow_up' | 'none';
    effectReason: string | null;
    followedUpAt: string | null;
  } | null;
  subject: Record<string, unknown> | null;
  mine?: boolean;
  ownDecision?: boolean;
  grounds: string | null;
  attachments: { fileId: string; url: string | null }[];
}

/**
 * Helpers for the decision appeals (ADR 0059): a compound whose manager
 * rejects, a second manager who decides the appeal, each kind of decision
 * made as the domains make it, and the routes over HTTP.
 */
export function decisionAppealHelpers(h: HttpHarness) {
  const p = permitHelpers(h);
  const { v, http } = p;

  /** Another manager of the compound, with a session: the appeal's decider. */
  async function secondManager(c: Compound): Promise<Who> {
    const account = await v.x.asManager(c, () =>
      h.moduleRef.get(AccountsService).create({
        type: 'manager',
        fullName: `Manager ${uniqueSuffix()}`,
        idDocumentType: 'national_id',
        idDocumentNumber: nationalIdFor(),
        phone: uniquePhone(),
        email: uniqueEmail('manager'),
      }),
    );
    return p.who(c, account.id, 'manager');
  }

  /**
   * A compound whose rules take any day and hour, its manager (who decides
   * the subjects), a second manager (who decides the appeals) and a home
   * where `alice` lives, its primary.
   */
  async function setUp(name = 'Appeals Court') {
    const s = await p.setUp(name);
    await p.anyTime(s.manager);
    return { ...s, decider: await secondManager(s.c) };
  }

  /** A works permit asked by `as` and rejected by `manager`: its id. */
  async function rejectedPermit(
    manager: Who,
    as: Who,
    unitId: string,
    over: Record<string, unknown> = {},
  ): Promise<string> {
    const permit = await p.works(as, unitId, over);
    await p
      .decide(manager, permit.id, 'reject', { reasonCode: 'outside_rules' })
      .expect(200);
    return permit.id;
  }

  /** A vehicle registered by `as` and rejected by `manager`: its id. */
  async function rejectedVehicle(
    manager: Who,
    as: Who,
    unitId: string,
  ): Promise<string> {
    const vehicle = await v.register(as, unitId, { plate: plate() });
    await http('post', `/staff/vehicles/${vehicle.id}/reject`, manager.token, {
      version: (await v.staffView(manager, vehicle.id)).version,
      reasonCode: 'plate_mismatch',
    }).expect(200);
    return vehicle.id;
  }

  /** A worker registered by `primary` and rejected by the manager: the engagement's id. */
  async function rejectedWorker(
    c: Compound,
    primary: Who,
    unitId: string,
  ): Promise<string> {
    const person = v.x.person('worker');
    const reg = await v.x.as(c, { id: primary.id, type: 'resident' }, () =>
      h.moduleRef.get(WorkersService).register(unitId, {
        fullName: person.fullName,
        idDocumentType: 'national_id',
        idDocumentNumber: person.idDocumentNumber,
        phone: person.phone,
        capacity: 'nanny',
        schedule: aroundTheClock(),
      }),
    );
    await v.x.asManager(c, () =>
      h.moduleRef.get(WorkersService).review(reg.engagementId, 'reject', {
        reason: { code: 'documents_invalid', text: 'The ID copy is blurred.' },
      }),
    );
    return reg.engagementId;
  }

  /** `POST /decision-appeals` as `as`. */
  function lodgeRaw(
    as: Who,
    kind: string,
    subjectId: string,
    over: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    return http(
      'post',
      '/decision-appeals',
      as.token,
      {
        kind,
        subjectId,
        grounds: 'The decision misread the request.',
        ...over,
      },
      headers,
    );
  }

  /** An appeal that must be lodged: the appellant's view. */
  async function lodge(
    as: Who,
    kind: string,
    subjectId: string,
    over: Record<string, unknown> = {},
  ): Promise<DecisionAppealBody> {
    return (await lodgeRaw(as, kind, subjectId, over).expect(201))
      .body as DecisionAppealBody;
  }

  /** `POST /staff/decision-appeals/:id/decide` as `as`. */
  function decideRaw(
    as: Who,
    id: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return (async () =>
      await http('post', `/staff/decision-appeals/${id}/decide`, as.token, {
        rationale: 'Reviewed against the compound’s rules.',
        ...body,
      }))();
  }

  /** A decision that must be taken: the deciders' view. */
  async function decide(
    as: Who,
    id: string,
    body: Record<string, unknown>,
  ): Promise<DecisionAppealBody> {
    const res = await decideRaw(as, id, body);
    if (res.status !== 200)
      throw new Error(`decide: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as DecisionAppealBody;
  }

  /** `POST /decision-appeals/:id/withdraw` as `as`. */
  function withdrawRaw(as: Who, id: string) {
    return http('post', `/decision-appeals/${id}/withdraw`, as.token);
  }

  /** The appeal's row. */
  function row(c: Compound, id: string) {
    return v.inTx(c, (tx) =>
      tx.decisionAppeal.findUniqueOrThrow({ where: { id } }),
    );
  }

  return {
    ...p,
    /** The permits' own decision (`decide` here is the appeal's). */
    decidePermit: p.decide,
    secondManager,
    setUp,
    rejectedPermit,
    rejectedVehicle,
    rejectedWorker,
    lodgeRaw,
    lodge,
    decideRaw,
    decide,
    withdrawRaw,
    row,
  };
}

export type DecisionAppealsSetUp = Awaited<
  ReturnType<ReturnType<typeof decisionAppealHelpers>['setUp']>
>;
