import { Injectable } from '@nestjs/common';
import type {
  Account,
  Gate,
  GateServiceRequest,
  GateServiceStatus,
  Place,
} from '@prisma/client';
import { appError, ErrorCode } from '../../core/common/errors';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { dbNow } from '../db-clock';
import { SafetyCore, type UnitLocation } from '../safety/safety-core';

export const GATE_SERVICE_RESOURCE = 'gate_service_request';

export const LIVE_SERVICE: GateServiceStatus[] = [
  'open',
  'accepted',
  'in_progress',
];

export type Person = Pick<Account, 'id' | 'fullName' | 'status'>;

export const gateServiceNotFound = () =>
  appError.notFound(ErrorCode.GATE_SERVICE_NOT_FOUND, 'Request not found');

/** A request with what its views show, read in one transaction. */
export interface GateServiceRecord {
  request: GateServiceRequest;
  location: UnitLocation;
  requester: Person;
  handler: Person | null;
  /** The phone the handler gives: their gate's now, else the compound's. */
  handlerPhone: string | null;
  member: { id: string; firstName: string | null } | null;
  places: Map<string, Place>;
  gate: Pick<Gate, 'id' | 'name'> | null;
  /** A presigned URL of the photo, valid for minutes. */
  photoUrl: string | null;
  now: Date;
}

/**
 * Reads a gate service request for its views (ADR 0047), and locks its row.
 * Shared by the requester's side and security's.
 */
@Injectable()
export class GateServiceRecords {
  constructor(
    private readonly core: SafetyCore,
    private readonly files: FilesService,
  ) {}

  async lock(tx: TenantTxClient, id: string): Promise<GateServiceRequest> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM gate_service_requests WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw gateServiceNotFound();
    return tx.gateServiceRequest.findUniqueOrThrow({ where: { id } });
  }

  async load(
    tx: TenantTxClient,
    r: GateServiceRequest,
  ): Promise<GateServiceRecord> {
    return (await this.loadMany(tx, [r]))[0];
  }

  async loadMany(
    tx: TenantTxClient,
    list: GateServiceRequest[],
  ): Promise<GateServiceRecord[]> {
    if (!list.length) return [];
    const people = new Map(
      (
        await tx.account.findMany({
          where: {
            id: {
              in: [
                ...new Set(
                  list.flatMap((r) =>
                    r.handledById
                      ? [r.requestedById, r.handledById]
                      : [r.requestedById],
                  ),
                ),
              ],
            },
          },
          select: { id: true, fullName: true, status: true },
        })
      ).map((a) => [a.id, a]),
    );
    const placeIds = list.flatMap((r) =>
      [r.fromPlaceId, r.toPlaceId, r.placeId].filter(
        (p): p is string => p !== null,
      ),
    );
    const places = new Map(
      (
        await tx.place.findMany({
          where: { id: { in: [...new Set(placeIds)] } },
        })
      ).map((p) => [p.id, p]),
    );
    const gates = new Map(
      (
        await tx.gate.findMany({
          where: {
            id: {
              in: list.flatMap((r) => (r.gateId ? [r.gateId] : [])),
            },
          },
          select: { id: true, name: true },
        })
      ).map((g) => [g.id, g]),
    );
    const members = await this.core.memberNames(
      tx,
      list.flatMap((r) => (r.memberId ? [r.memberId] : [])),
    );
    const locations = await this.core.locations(
      tx,
      list.map((r) => r.unitId),
    );
    const now = await dbNow(tx);
    const out: GateServiceRecord[] = [];
    for (const r of list) {
      let handlerPhone: string | null = null;
      if (r.handledById) {
        const shift = await tx.guardShift.findFirst({
          where: { guardAccountId: r.handledById, endedAt: null },
          select: { gateId: true },
        });
        handlerPhone = await this.core.responderPhone(
          tx,
          shift?.gateId ?? null,
        );
      }
      out.push({
        request: r,
        location: locations.get(r.unitId)!,
        requester: people.get(r.requestedById)!,
        handler: r.handledById ? (people.get(r.handledById) ?? null) : null,
        handlerPhone,
        member: r.memberId
          ? { id: r.memberId, firstName: members.get(r.memberId) ?? null }
          : null,
        places,
        gate: r.gateId ? (gates.get(r.gateId) ?? null) : null,
        photoUrl: (await this.files.readUrl(tx, r.photoFileId))?.url ?? null,
        now,
      });
    }
    return out;
  }
}
