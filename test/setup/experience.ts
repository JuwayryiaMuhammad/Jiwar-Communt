import { SIGNALS_SWEEP } from '../../src/core/experience/experience-signals.service';
import type { TenantTxClient } from '../../src/core/database/tenant-tx.service';
import { boardMatterHelpers } from './board-matters';
import type { Compound } from './community';
import { daysLater, dbClock } from './compound-clock';
import { batchRow, invoiceRow } from './finance-rows';
import type { HttpHarness } from './http-app';
import { requestRow, topicRow } from './management-rows';
import { categoryRow, complaintRow } from './neighbours-rows';

export interface CaseBody {
  id: string;
  number: string;
  unitId: string;
  unitCode: string | null;
  kind: string;
  origin: string;
  status: string;
  ownerId: string | null;
  dueAt: string | null;
  outcome: string | null;
  signals?: { id: string; code: string; caseId: string }[];
  compensations?: CompensationBody[];
}

export interface CompensationBody {
  id: string;
  caseId: string;
  kind: string;
  amount: string | null;
  status: string;
  creditNoteId: string | null;
  authorizationId: string | null;
  rejectReason: string | null;
  authority: {
    threshold: string | null;
    binding: boolean;
    decider: string;
  } | null;
}

/**
 * Experience and recovery's suites (ADR 0082): the board's compound (a
 * manager, owners of a unit each, a sitting board), and what the rules count
 * written straight into the tables: a management request of the unit rated
 * 1, a complaint the unit made about a neighbour.
 */
export function experienceHelpers(h: HttpHarness) {
  const b = boardMatterHelpers(h);
  const { http, inTx } = b;

  /** `n` management requests of the unit, each rated 1 a day ago. */
  async function lowRatings(
    c: Compound,
    owner: { id: string; unitId: string },
    n: number,
    at: Date = daysLater(-1),
  ): Promise<string[]> {
    return inTx(c, async (tx) => {
      const topicId = await topicRow(tx, c.tenantId);
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const id = await requestRow(tx, {
          tenantId: c.tenantId,
          topicId,
          authorId: owner.id,
        });
        await tx.managementRequest.update({
          where: { id },
          data: { unitId: owner.unitId },
        });
        await tx.managementRequestRating.create({
          data: {
            tenantId: c.tenantId,
            requestId: id,
            authorId: owner.id,
            rating: 1,
            lowReasonCode: 'slow',
            createdAt: at,
          },
        });
        ids.push(id);
      }
      return ids;
    });
  }

  /** `n` complaints the unit made about another unit, now (a complaint keeps its row). */
  async function complaints(
    c: Compound,
    owner: { id: string; unitId: string },
    about: string,
    n: number,
  ): Promise<string[]> {
    return inTx(c, async (tx) => {
      const categoryId = await categoryRow(tx, c.tenantId);
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const id = await complaintRow(tx, {
          tenantId: c.tenantId,
          authorId: owner.id,
          authorUnitId: owner.unitId,
          targetUnitId: about,
          categoryId,
        });
        ids.push(id);
      }
      return ids;
    });
  }

  /** An open invoice of the unit's, of `total`. */
  const invoice = (c: Compound, unitId: string, total = '1000.00') =>
    inTx(c, async (tx: TenantTxClient) => {
      const batchId = await batchRow(tx, {
        tenantId: c.tenantId,
        unitId,
        createdById: c.managerId,
      });
      return invoiceRow(tx, {
        tenantId: c.tenantId,
        unitId,
        batchId,
        createdById: c.managerId,
        total,
      });
    });

  /** One run of the signals sweep, a minute ahead of the database's clock. */
  const signals = (now: Date = new Date(dbClock().getTime() + 60_000)) =>
    b.sweep(SIGNALS_SWEEP, now);

  const api = (
    method: 'get' | 'post' | 'patch' | 'put',
    path: string,
    token: string,
    body?: object,
  ) => http(method, `/staff/experience${path}`, token, body);

  /** `POST /staff/experience/cases`: the case, or throws. */
  async function openCase(
    token: string,
    body: Record<string, unknown>,
  ): Promise<CaseBody> {
    const res = await api('post', '/cases', token, {
      kind: 'recovery',
      ...body,
    });
    if (res.status !== 201)
      throw new Error(`open: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as CaseBody;
  }

  const getCase = async (token: string, id: string): Promise<CaseBody> =>
    (await api('get', `/cases/${id}`, token).expect(200)).body as CaseBody;

  /** The unit's cases, as rows. */
  const casesOf = (c: Compound, unitId: string) =>
    inTx(c, (tx) =>
      tx.experienceCase.findMany({
        where: { unitId },
        orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
      }),
    );

  const signalsOf = (c: Compound, unitId: string) =>
    inTx(c, (tx) =>
      tx.experienceSignal.findMany({
        where: { unitId },
        orderBy: [{ detectedAt: 'asc' }, { id: 'asc' }],
      }),
    );

  async function propose(
    token: string,
    caseId: string,
    body: Record<string, unknown>,
  ): Promise<CompensationBody> {
    const res = await api('post', `/cases/${caseId}/compensations`, token, {
      failureCode: 'maintenance_delay',
      ...body,
    });
    if (res.status !== 201)
      throw new Error(`propose: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body as CompensationBody;
  }

  const decide = (token: string, id: string, body: Record<string, unknown>) =>
    api('post', `/compensations/${id}/decide`, token, body);

  return {
    ...b,
    lowRatings,
    complaints,
    invoice,
    signals,
    api,
    openCase,
    getCase,
    casesOf,
    signalsOf,
    propose,
    decide,
  };
}

export type ExperienceSetUp = Awaited<
  ReturnType<ReturnType<typeof experienceHelpers>['setUp']>
>;
