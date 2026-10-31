import { Injectable } from '@nestjs/common';
import type { BusDeparture, BusRoute } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import {
  addDays,
  localParts,
  weekdayOf,
  zonedInstant,
  type LocalDate,
} from '../../core/common/slots/day-slots';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { dbNow } from '../db-clock';

export const BUS_NAME_LENGTH = { min: 1, max: 80 } as const;
export const STOP_LENGTH = { min: 1, max: 80 } as const;
/** The next departures the brief shows. */
export const NEXT_DEPARTURES = 3;

export type RouteWithDepartures = BusRoute & { departures: BusDeparture[] };

/** A departure at an instant: the next ones, today's and tomorrow's. */
export interface NextDeparture {
  route: Pick<BusRoute, 'id' | 'nameEn' | 'nameAr'>;
  departure: BusDeparture;
  at: Date;
}

/** A bit a weekday, Sunday the lowest. */
export const weekdayBits = (days: readonly number[]): number =>
  [...new Set(days)].reduce((bits, d) => bits | (1 << d), 0);
export const weekdaysOf = (bits: number): number[] =>
  [0, 1, 2, 3, 4, 5, 6].filter((d) => (bits & (1 << d)) !== 0);

export const busRouteNotFound = () =>
  appError.notFound(ErrorCode.BUS_ROUTE_NOT_FOUND, 'Bus route not found');

/**
 * The compound's buses (ADR 0071): routes and their departures on some
 * weekdays at a local time of day. The manager keeps the timetable
 * (`content.manage`); residents read it and the next departures on the
 * compound's clock, a day whose local time does not exist (a
 * daylight-saving gap) skipping that departure.
 */
@Injectable()
export class BusesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly tenantSettings: TenantSettingsService,
    private readonly audit: AuditService,
  ) {}

  createRoute(input: { nameEn: string; nameAr: string }): Promise<BusRoute> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const route = await tx.busRoute.create({
        data: {
          id: newId(),
          tenantId: this.ctx.tenantId,
          nameEn: input.nameEn.trim(),
          nameAr: input.nameAr.trim(),
        },
      });
      await this.audit.record(tx, {
        action: 'bus_route.created',
        targetId: route.id,
      });
      return route;
    });
  }

  updateRoute(
    id: string,
    input: { nameEn?: string; nameAr?: string; active?: boolean },
  ): Promise<BusRoute> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const before = await this.lockRoute(tx, id);
      const route = await tx.busRoute.update({
        where: { id },
        data: {
          nameEn: input.nameEn?.trim(),
          nameAr: input.nameAr?.trim(),
          active: input.active,
        },
      });
      await this.audit.record(tx, {
        action: 'bus_route.updated',
        targetId: id,
        metadata: {
          active: route.active,
          renamed:
            route.nameEn !== before.nameEn || route.nameAr !== before.nameAr,
        },
      });
      return route;
    });
  }

  addDeparture(
    routeId: string,
    input: {
      weekdays: number[];
      time: string;
      fromStop: string;
      toStop: string;
    },
  ): Promise<BusDeparture> {
    const [h, m] = input.time.split(':').map(Number);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lockRoute(tx, routeId);
      const departure = await tx.busDeparture.create({
        data: {
          id: newId(),
          tenantId: this.ctx.tenantId,
          routeId,
          weekdays: weekdayBits(input.weekdays),
          departsMinute: h * 60 + m,
          fromStop: input.fromStop.trim(),
          toStop: input.toStop.trim(),
        },
      });
      await this.audit.record(tx, {
        action: 'bus_departure.added',
        targetId: departure.id,
        metadata: {
          routeId,
          weekdays: departure.weekdays,
          departsMinute: departure.departsMinute,
        },
      });
      return departure;
    });
  }

  removeDeparture(id: string): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const departure = await tx.busDeparture.findUnique({ where: { id } });
      if (!departure)
        throw appError.notFound(
          ErrorCode.BUS_DEPARTURE_NOT_FOUND,
          'Departure not found',
        );
      await this.lockRoute(tx, departure.routeId);
      await tx.busDeparture.delete({ where: { id } });
      await this.audit.record(tx, {
        action: 'bus_departure.removed',
        targetId: id,
        metadata: { routeId: departure.routeId },
      });
    });
  }

  /** Every route with its departures; residents get the active ones. */
  routes(all: boolean): Promise<RouteWithDepartures[]> {
    return this.tenantTx.withTenantTx((tx) => this.routesIn(tx, all));
  }

  /** The next departures from now, today's and tomorrow's, soonest first. */
  async next(
    tx: TenantTxClient,
    limit = NEXT_DEPARTURES,
  ): Promise<NextDeparture[]> {
    const routes = await this.routesIn(tx, false);
    if (!routes.length) return [];
    const now = await dbNow(tx);
    const { timezone } = await this.tenantSettings.inTx(
      tx,
      this.ctx.txTenantId,
    );
    const { date } = localParts(now, timezone);
    const out: NextDeparture[] = [];
    for (const day of [date, addDays(date, 1)] as LocalDate[]) {
      const weekday = weekdayOf(day);
      for (const route of routes)
        for (const departure of route.departures) {
          if ((departure.weekdays & (1 << weekday)) === 0) continue;
          const at = zonedInstant(day, departure.departsMinute, timezone);
          if (!at || at.getTime() <= now.getTime()) continue;
          out.push({
            route: { id: route.id, nameEn: route.nameEn, nameAr: route.nameAr },
            departure,
            at,
          });
        }
    }
    return out
      .sort(
        (a, b) =>
          a.at.getTime() - b.at.getTime() ||
          a.departure.id.localeCompare(b.departure.id),
      )
      .slice(0, limit);
  }

  nextNow(): Promise<NextDeparture[]> {
    return this.tenantTx.withTenantTx((tx) => this.next(tx, 20));
  }

  private routesIn(
    tx: TenantTxClient,
    all: boolean,
  ): Promise<RouteWithDepartures[]> {
    return tx.busRoute.findMany({
      where: all ? {} : { active: true },
      include: {
        departures: { orderBy: [{ departsMinute: 'asc' }, { id: 'asc' }] },
      },
      orderBy: [{ nameEn: 'asc' }, { id: 'asc' }],
    });
  }

  private async lockRoute(tx: TenantTxClient, id: string): Promise<BusRoute> {
    await tx.$queryRaw`SELECT id FROM bus_routes WHERE id = ${id}::uuid FOR UPDATE`;
    const route = await tx.busRoute.findUnique({ where: { id } });
    if (!route) throw busRouteNotFound();
    return route;
  }
}
