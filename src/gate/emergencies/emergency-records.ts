import { Injectable } from '@nestjs/common';
import type { Account, Emergency, EmergencyStatus } from '@prisma/client';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { SafetyCore, type UnitLocation } from '../safety/safety-core';

export const EMERGENCY_RESOURCE = 'emergency';

export const OPEN_EMERGENCY: EmergencyStatus[] = [
  'reported',
  'on_the_way',
  'arrived',
];

export type Person = Pick<Account, 'id' | 'fullName' | 'status'>;

export const emergencyNotFound = () =>
  appError.notFound(ErrorCode.EMERGENCY_NOT_FOUND, 'Emergency not found');

export const emergencyClosed = (status: EmergencyStatus) =>
  appError.conflict(
    ErrorCode.EMERGENCY_CLOSED,
    'The emergency was resolved or cancelled already',
    { params: { status } },
  );

export interface FamilyAlert {
  person: Person;
  notifiedAt: Date;
  onMyWayAt: Date | null;
}

/** An emergency with what its views show, read in one transaction. */
export interface EmergencyRecord {
  emergency: Emergency;
  location: UnitLocation;
  reporter: Person;
  responder: Person | null;
  /** The phone the responder gives: their gate's, else the compound's. */
  responderPhone: string | null;
  alerts: FamilyAlert[];
  /** The database's now, for the countdown. */
  now: Date;
}

/**
 * Reads an emergency for its views (ADR 0047), and locks its row. Shared by
 * the household's side and the responders'.
 */
@Injectable()
export class EmergencyRecords {
  constructor(private readonly core: SafetyCore) {}

  /** The row, locked FOR UPDATE (a write on it) or FOR SHARE (a write beside it). */
  async lock(
    tx: TenantTxClient,
    id: string,
    mode: 'update' | 'share',
  ): Promise<Emergency> {
    const rows =
      mode === 'update'
        ? await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM emergencies WHERE id = ${id}::uuid FOR UPDATE`
        : await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM emergencies WHERE id = ${id}::uuid FOR SHARE`;
    if (!rows.length) throw emergencyNotFound();
    return tx.emergency.findUniqueOrThrow({ where: { id } });
  }

  async load(tx: TenantTxClient, e: Emergency): Promise<EmergencyRecord> {
    return (await this.loadMany(tx, [e]))[0];
  }

  async loadMany(
    tx: TenantTxClient,
    list: Emergency[],
  ): Promise<EmergencyRecord[]> {
    if (!list.length) return [];
    const ids = list.map((e) => e.id);
    const alerts = await tx.emergencyFamilyAlert.findMany({
      where: { emergencyId: { in: ids } },
      orderBy: [{ notifiedAt: 'asc' }, { accountId: 'asc' }],
    });
    const people = new Map(
      (
        await tx.account.findMany({
          where: {
            id: {
              in: [
                ...new Set([
                  ...list.flatMap((e) =>
                    e.responderId
                      ? [e.reportedById, e.responderId]
                      : [e.reportedById],
                  ),
                  ...alerts.map((a) => a.accountId),
                ]),
              ],
            },
          },
          select: { id: true, fullName: true, status: true },
        })
      ).map((a) => [a.id, a]),
    );
    const locations = await this.core.locations(
      tx,
      list.map((e) => e.unitId),
    );
    const now = await dbNow(tx);
    const out: EmergencyRecord[] = [];
    for (const e of list)
      out.push({
        emergency: e,
        location: locations.get(e.unitId)!,
        reporter: people.get(e.reportedById)!,
        responder: e.responderId ? (people.get(e.responderId) ?? null) : null,
        responderPhone: e.responderId
          ? await this.core.responderPhone(tx, e.responderGateId)
          : null,
        alerts: alerts
          .filter((a) => a.emergencyId === e.id)
          .map((a) => ({
            person: people.get(a.accountId)!,
            notifiedAt: a.notifiedAt,
            onMyWayAt: a.onMyWayAt,
          })),
        now,
      });
    return out;
  }
}
