import { Injectable } from '@nestjs/common';
import type { ServicePromise } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { RequestContext } from '../common/cls/request-context';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../common/errors';
import { invalid } from '../common/localized';
import type { LocalDate } from '../common/slots/day-slots';
import { newId } from '../common/uuid';
import { TenantTx } from '../database/tenant-tx.service';
import { TenantSettingsService } from '../tenant-settings/tenant-settings.service';
import { clock } from './experience-locks';
import { periodOf, type Period } from './experience-period';
import {
  ExperienceSources,
  HOURS_METRICS,
  RATING_METRIC_SOURCE,
  type HoursMetric,
  type PromiseMetric,
} from './experience-sources';

export const PROMISE_TITLE = { min: 1, max: 200 } as const;
export const HOURS_TARGET = { min: 1, max: 8760 } as const;
export const RATING_TARGET = { min: 1, max: 5 } as const;
export const SHARE_TARGET = { min: 1, max: 100 } as const;
/** The register is short: at most this many promises. */
export const MAX_PROMISES = 100;

export interface PromiseTerms {
  metric: PromiseMetric | null;
  target: number | null;
  targetShare: number | null;
}

/** One promise against its target over a period. */
export interface PromiseMeasurement {
  promise: ServicePromise;
  /** False for a promise with no metric: listed, not measured. */
  measured: boolean;
  /** The items measured (tickets, requests, ratings). */
  items: number;
  /** A share within the hours (0–100), or the average rating; null without items. */
  value: number | null;
  /** Whether the value meets the target; null when nothing was measured. */
  met: boolean | null;
}

export const promiseNotFound = () =>
  appError.notFound(
    ErrorCode.SERVICE_PROMISE_NOT_FOUND,
    'Service promise not found',
  );

const isHours = (m: PromiseMetric): m is HoursMetric =>
  (HOURS_METRICS as readonly string[]).includes(m);

/** The terms' shape, as the table's CHECK holds it, field by field. */
export function checkTerms(t: PromiseTerms): void {
  const fields: FieldError[] = [];
  if (t.metric === null) {
    if (t.target !== null)
      fields.push({ field: 'target', code: FieldErrorCode.FIELD_NOT_ALLOWED });
    if (t.targetShare !== null)
      fields.push({
        field: 'targetShare',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
  } else {
    const range = isHours(t.metric) ? HOURS_TARGET : RATING_TARGET;
    if (t.target === null)
      fields.push({ field: 'target', code: FieldErrorCode.FIELD_REQUIRED });
    else if (t.target < range.min || t.target > range.max)
      fields.push({
        field: 'target',
        code: FieldErrorCode.INVALID_NUMBER,
        params: { ...range },
      });
    if (isHours(t.metric) && t.targetShare === null)
      fields.push({
        field: 'targetShare',
        code: FieldErrorCode.FIELD_REQUIRED,
      });
    if (!isHours(t.metric) && t.targetShare !== null)
      fields.push({
        field: 'targetShare',
        code: FieldErrorCode.FIELD_NOT_ALLOWED,
      });
  }
  if (fields.length) throw invalid(fields);
}

/**
 * The service promises register (ADR 0082): what the compound promises
 * its residents, in both languages, and its target, measured where the data
 * exists: a ticket resolved or a request answered within so many hours for
 * a share of them (the domains measure it), or a service's average rating.
 * A promise with no metric is listed, not measured. Kept with
 * `experience.manage`; retired, never deleted. Its titles never reach the
 * audit trail.
 */
@Injectable()
export class ServicePromisesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly settings: TenantSettingsService,
    private readonly sources: ExperienceSources,
  ) {}

  list(q: { active?: boolean }): Promise<ServicePromise[]> {
    return this.tenantTx.withTenantTx((tx) =>
      tx.servicePromise.findMany({
        where: q.active === undefined ? {} : { active: q.active },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: MAX_PROMISES,
      }),
    );
  }

  create(
    input: { titleEn: string; titleAr: string } & PromiseTerms,
  ): Promise<ServicePromise> {
    checkTerms(input);
    return this.tenantTx.withTenantTx(async (tx) => {
      const tenantId = this.ctx.txTenantId;
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext(${`service-promises:${tenantId}`}))`;
      if ((await tx.servicePromise.count()) >= MAX_PROMISES)
        throw invalid([
          {
            field: 'titleEn',
            code: FieldErrorCode.INVALID_VALUE,
            params: { max: MAX_PROMISES },
          },
        ]);
      const now = await clock(tx);
      const row = await tx.servicePromise.create({
        data: {
          id: newId(),
          tenantId,
          titleEn: input.titleEn.trim(),
          titleAr: input.titleAr.trim(),
          metric: input.metric,
          target: input.target,
          targetShare: input.targetShare,
          createdById: this.ctx.accountId,
          createdAt: now,
          updatedAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'service_promise.created',
        targetId: row.id,
        metadata: {
          metric: row.metric,
          target: row.target?.toFixed(2) ?? null,
          targetShare: row.targetShare,
        },
      });
      return row;
    });
  }

  update(
    id: string,
    input: Partial<{ titleEn: string; titleAr: string; active: boolean }> &
      Partial<PromiseTerms>,
  ): Promise<ServicePromise> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM service_promises WHERE id = ${id}::uuid FOR UPDATE`;
      const before = await tx.servicePromise.findUnique({ where: { id } });
      if (!before) throw promiseNotFound();
      const terms: PromiseTerms = {
        metric:
          input.metric !== undefined
            ? input.metric
            : (before.metric as PromiseMetric | null),
        target:
          input.target !== undefined
            ? input.target
            : before.target === null
              ? null
              : Number(before.target),
        targetShare:
          input.targetShare !== undefined
            ? input.targetShare
            : before.targetShare,
      };
      checkTerms(terms);
      const after = await tx.servicePromise.update({
        where: { id },
        data: {
          ...(input.titleEn !== undefined
            ? { titleEn: input.titleEn.trim() }
            : {}),
          ...(input.titleAr !== undefined
            ? { titleAr: input.titleAr.trim() }
            : {}),
          ...(input.active !== undefined ? { active: input.active } : {}),
          ...terms,
          updatedAt: await clock(tx),
        },
      });
      await this.audit.record(tx, {
        action: 'service_promise.updated',
        targetId: id,
        metadata: {
          metric: after.metric,
          target: after.target?.toFixed(2) ?? null,
          targetShare: after.targetShare,
          active: after.active,
          titles:
            after.titleEn !== before.titleEn ||
            after.titleAr !== before.titleAr,
        },
      });
      return after;
    });
  }

  /** The active promises against their targets over the compound's days. */
  report(q: {
    from?: LocalDate;
    to?: LocalDate;
  }): Promise<{ period: Period; items: PromiseMeasurement[] }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const period = await periodOf(tx, this.settings, this.ctx.txTenantId, q);
      const promises = await tx.servicePromise.findMany({
        where: { active: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const range = { from: period.start, to: period.end };
      const ratings = promises.some(
        (p) => p.metric !== null && !isHours(p.metric as PromiseMetric),
      )
        ? await this.sources.ratings(tx, period.start, period.end)
        : [];
      const items: PromiseMeasurement[] = [];
      for (const promise of promises) {
        const metric = promise.metric as PromiseMetric | null;
        if (metric === null) {
          items.push({
            promise,
            measured: false,
            items: 0,
            value: null,
            met: null,
          });
          continue;
        }
        const target = Number(promise.target);
        if (isHours(metric)) {
          const measure = this.sources.measure(metric);
          const got = measure
            ? await measure(tx, range, target)
            : { items: 0, within: 0 };
          const value = got.items
            ? Math.round((got.within / got.items) * 1000) / 10
            : null;
          items.push({
            promise,
            measured: true,
            items: got.items,
            value,
            met: value === null ? null : value >= promise.targetShare!,
          });
        } else {
          const of = ratings.filter(
            (r) => r.source === RATING_METRIC_SOURCE[metric],
          );
          const value = of.length
            ? Math.round(
                (of.reduce((n, r) => n + r.rating, 0) / of.length) * 100,
              ) / 100
            : null;
          items.push({
            promise,
            measured: true,
            items: of.length,
            value,
            met: value === null ? null : value >= target,
          });
        }
      }
      return { period, items };
    });
  }
}
