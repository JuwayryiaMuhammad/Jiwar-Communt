import { Injectable } from '@nestjs/common';
import { CommunityGatePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { AppException } from '../../core/common/errors';
import { plateKey } from '../../core/common/vehicle-plate';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { BlocklistMatcher } from '../blocklist/blocklist-matcher';
import { ChildGateService } from '../children/child-gate.service';
import { PatrolScansService } from '../patrols/patrol-scans.service';
import { PermitIdCheck } from '../permits/permit-id-check';
import { clean } from '../permits/permits.service';
import type { NewFlag } from './offline-flags.service';
import { OfflineEntries } from './offline-entries';
import type {
  ChildExitAction,
  ContractorAction,
  FlagKind,
  MaterialEntryAction,
  OfflineAction,
  PatrolScanAction,
  Rejection,
  ServiceVehicleInAction,
  ServiceVehicleOutAction,
} from './offline-rules';

/** Where and by whom an action happened: its bundle's. */
export interface HandlerContext {
  occurredAt: Date;
  gateId: string;
  gateName: string;
  shiftId: string;
  guardId: string;
  timezone: string;
  /** The action's own row id (its client id), for the audit. */
  actionId: string;
}

/** What an action recorded: one row of its kind, or none. */
export interface Recorded {
  entryId?: string;
  serviceVehicleVisitId?: string;
  materialEntryId?: string;
  patrolScanId?: string;
  childPickupId?: string;
}

export type FlagDraft = Omit<NewFlag, 'batchId' | 'deviceId'>;

export type HandlerOutcome =
  | { recorded: Recorded; flags: FlagDraft[] }
  | { rejection: Rejection; params?: Record<string, string | number> };

/**
 * What each offline action records at sync (ADR 0057), the prefix held by
 * the caller (the account, the bundle's shift, the device, the lockdown
 * row): an entry (OfflineEntries), a contractor found by the last four of
 * their ID, a service vehicle in or out by its plate, a material entry, a
 * patrol's scan. What happened is recorded; what the server knows better is
 * flagged; what cannot be attributed is rejected with its reason.
 */
@Injectable()
export class OfflineHandlers {
  constructor(
    private readonly ctx: RequestContext,
    private readonly entries: OfflineEntries,
    private readonly ids: PermitIdCheck,
    private readonly matcher: BlocklistMatcher,
    private readonly community: CommunityGatePort,
    private readonly audit: AuditService,
    private readonly patrols: PatrolScansService,
    private readonly children: ChildGateService,
  ) {}

  async handle(
    tx: TenantTxClient,
    a: OfflineAction,
    c: HandlerContext,
  ): Promise<HandlerOutcome> {
    switch (a.type) {
      case 'entry':
        return this.entry(tx, a, c);
      case 'contractor':
        return this.contractor(tx, a, c);
      case 'service_vehicle_in':
        return this.vehicleIn(tx, a, c);
      case 'service_vehicle_out':
        return this.vehicleOut(tx, a, c);
      case 'material_entry':
        return this.material(tx, a, c);
      case 'patrol_scan':
        return this.patrol(tx, a, c);
      case 'child_exit':
        return this.childExit(tx, a, c);
    }
  }

  /**
   * A child's exit (ADR 0054), as ChildGateService.recordOffline decides
   * it; a release it could not verify is a security flag too.
   */
  private async childExit(
    tx: TenantTxClient,
    a: ChildExitAction,
    c: HandlerContext,
  ): Promise<HandlerOutcome> {
    const out = await this.children.recordOffline(tx, a, c);
    if ('rejection' in out) return out;
    return {
      recorded: { childPickupId: out.pickupId },
      flags: out.unverified
        ? [
            {
              kind: 'child_exit_unverified',
              subject: { type: 'child_control', id: a.controlId },
              gateId: c.gateId,
              shiftId: c.shiftId,
              params: { reason: out.unverified },
            },
          ]
        : [],
    };
  }

  private async entry(
    tx: TenantTxClient,
    a: OfflineAction & { type: 'entry' },
    c: HandlerContext,
  ): Promise<HandlerOutcome> {
    const out = await this.entries.record(tx, { ...c, action: a });
    return 'rejection' in out
      ? out
      : { recorded: { entryId: out.entryId }, flags: out.flags };
  }

  /**
   * A contractor on a works permit: the worker whose ID ends with the last
   * four shown, among the permit's (removed ones too: their entry is
   * flagged). None, or more than one: not attributed — rejected, a security
   * flag. The last four are matched in constant time and never kept.
   */
  private async contractor(
    tx: TenantTxClient,
    a: ContractorAction,
    c: HandlerContext,
  ): Promise<HandlerOutcome> {
    const permit = await tx.unitPermit.findUnique({
      where: { id: a.permitId },
      select: { kind: true },
    });
    if (!permit || permit.kind !== 'works')
      return { rejection: 'subject_unknown' };
    const workers =
      a.idLast4 === null
        ? []
        : (
            await tx.permitWorker.findMany({
              where: { permitId: a.permitId, purgedAt: null },
              select: { id: true, idLast4Hash: true },
            })
          ).filter((w) => this.ids.matches(this.ctx.txTenantId, w, a.idLast4!));
    if (workers.length !== 1)
      return {
        rejection: 'contractor_unresolved',
        params: { matches: workers.length },
      };
    return this.entry(
      tx,
      {
        ...a,
        type: 'entry',
        subjectType: 'permit_worker',
        subjectId: workers[0].id,
        via: 'code',
      },
      c,
    );
  }

  /**
   * A service vehicle in by its plate (ADR 0056), at its device time. A
   * lockdown then, a ban or a watch then or now: flagged. Its plate inside
   * already (another device's, or an exit never recorded): the older visit
   * gets the system's unconfirmed exit at this entry, so one is inside. A
   * unit or facility the compound does not know is left out.
   */
  private async vehicleIn(
    tx: TenantTxClient,
    a: ServiceVehicleInAction,
    c: HandlerContext,
  ): Promise<HandlerOutcome> {
    const flags: FlagKind[] = [];
    const tenantId = this.ctx.txTenantId;
    if (await this.entries.lockdownAt(tx, c.gateId, c.occurredAt))
      flags.push('lockdown_entered');
    const key = plateKey(a.plate);
    const met = await this.matcher.plateAtSync(tx, key, c.occurredAt, {
      gateId: c.gateId,
      shiftId: c.shiftId,
      subject: { type: 'service_vehicle', id: a.clientId },
    });
    if (met)
      flags.push(
        met.kind === 'ban'
          ? 'blocklist_ban_entered'
          : 'blocklist_watch_entered',
      );
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`service-vehicle-plate:${tenantId}:${key}`}))`;
    const inside = await tx.serviceVehicleVisit.findFirst({
      where: { plateKey: key, exitedAt: null },
    });
    if (inside) {
      await tx.serviceVehicleVisit.update({
        where: { id: inside.id },
        data: {
          exitedAt:
            c.occurredAt > inside.enteredAt ? c.occurredAt : inside.enteredAt,
          exitedGateId: c.gateId,
          exitUnconfirmed: true,
        },
      });
      flags.push('duplicate_inside');
    }
    const unitId = a.unitCode
      ? ((await this.community.unitByCode(tx, a.unitCode))?.id ?? null)
      : null;
    const facilityId = a.facilityId
      ? ((
          await tx.facility.findUnique({
            where: { id: a.facilityId },
            select: { id: true },
          })
        )?.id ?? null)
      : null;
    const visit = await tx.serviceVehicleVisit.create({
      data: {
        id: a.clientId,
        tenantId,
        plate: a.plate,
        kind: a.kind,
        company: a.company,
        unitId,
        facilityId,
        enteredAt: c.occurredAt,
        enteredGateId: c.gateId,
        enteredShiftId: c.shiftId,
        enteredById: c.guardId,
      },
    });
    await this.audit.record(tx, {
      action: 'service_vehicle.entered',
      targetId: visit.id,
      metadata: {
        kind: a.kind,
        unitId,
        facilityId,
        gateId: c.gateId,
        shiftId: c.shiftId,
        offlineActionId: c.actionId,
      },
    });
    const of = { type: 'service_vehicle', id: visit.id };
    return {
      recorded: { serviceVehicleVisitId: visit.id },
      flags: flags.map((kind) => ({
        kind,
        subject: of,
        gateId: c.gateId,
        shiftId: c.shiftId,
      })),
    };
  }

  /**
   * Out by its plate: the visit inside with that plate closes at the
   * device's time (never before it came in). None inside: recorded with
   * nothing to close, flagged (its entry may be on another device).
   */
  private async vehicleOut(
    tx: TenantTxClient,
    a: ServiceVehicleOutAction,
    c: HandlerContext,
  ): Promise<HandlerOutcome> {
    const key = plateKey(a.plate);
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`service-vehicle-plate:${this.ctx.txTenantId}:${key}`}))`;
    const inside = await tx.serviceVehicleVisit.findFirst({
      where: { plateKey: key, exitedAt: null },
    });
    if (!inside)
      return {
        recorded: {},
        flags: [
          { kind: 'exit_without_entry', gateId: c.gateId, shiftId: c.shiftId },
        ],
      };
    await tx.$queryRaw`SELECT id FROM service_vehicle_visits WHERE id = ${inside.id}::uuid FOR UPDATE`;
    await tx.serviceVehicleVisit.update({
      where: { id: inside.id },
      data: {
        exitedAt:
          c.occurredAt > inside.enteredAt ? c.occurredAt : inside.enteredAt,
        exitedGateId: c.gateId,
        exitedShiftId: c.shiftId,
        exitedById: c.guardId,
      },
    });
    await this.audit.record(tx, {
      action: 'service_vehicle.exited',
      targetId: inside.id,
      metadata: {
        gateId: c.gateId,
        shiftId: c.shiftId,
        offlineActionId: c.actionId,
      },
    });
    return { recorded: { serviceVehicleVisitId: inside.id }, flags: [] };
  }

  /**
   * Materials in for a unit (ADR 0049), at the device's time. A unit the
   * compound does not know cannot have been served: rejected. A permit
   * that is not the unit's works permit is left out. A lockdown then is
   * flagged (nothing comes in during one).
   */
  private async material(
    tx: TenantTxClient,
    a: MaterialEntryAction,
    c: HandlerContext,
  ): Promise<HandlerOutcome> {
    const unit = await this.community.unitByCode(tx, a.unitCode);
    if (!unit) return { rejection: 'subject_unknown' };
    let permitId: string | null = null;
    if (a.permitId) {
      const p = await tx.unitPermit.findUnique({
        where: { id: a.permitId },
        select: { unitId: true, kind: true },
      });
      if (p && p.unitId === unit.id && p.kind === 'works')
        permitId = a.permitId;
    }
    const entry = await tx.materialEntry.create({
      data: {
        id: a.clientId,
        tenantId: this.ctx.txTenantId,
        unitId: unit.id,
        permitId,
        gateId: c.gateId,
        shiftId: c.shiftId,
        guardAccountId: c.guardId,
        description: clean(a.description),
        occurredAt: c.occurredAt,
      },
    });
    await this.audit.record(tx, {
      action: 'material_entry.logged',
      targetId: entry.id,
      metadata: {
        unitId: unit.id,
        permitId,
        gateId: c.gateId,
        offlineActionId: c.actionId,
      },
    });
    const lockdown = await this.entries.lockdownAt(tx, c.gateId, c.occurredAt);
    return {
      recorded: { materialEntryId: entry.id },
      flags: lockdown
        ? [
            {
              kind: 'lockdown_entered',
              subject: { type: 'material_entry', id: entry.id },
              gateId: c.gateId,
              shiftId: c.shiftId,
            },
          ]
        : [],
    };
  }

  /**
   * A checkpoint of the bundle's guard's run (ADR 0052), at the device's
   * time, as the run judges any scan: its window, its order, a checkpoint
   * reissued since. A refusal is the scan's own code: rejected, flagged for
   * the management (the guard scanned something; the run says no).
   */
  private async patrol(
    tx: TenantTxClient,
    a: PatrolScanAction,
    c: HandlerContext,
  ): Promise<HandlerOutcome> {
    const input = {
      id: a.clientId,
      method: a.method,
      ...(a.payload !== null ? { payload: a.payload } : {}),
      ...(a.checkpointId !== null ? { checkpointId: a.checkpointId } : {}),
      ...(a.reasonCode !== null ? { reasonCode: a.reasonCode } : {}),
      scannedAt: c.occurredAt,
      ...(a.lat !== null && a.lng !== null ? { lat: a.lat, lng: a.lng } : {}),
      ...(a.accuracyM !== null ? { accuracyM: a.accuracyM } : {}),
    };
    try {
      const reason = this.patrols.checkScan(input);
      const view = await this.patrols.scanIn(
        tx,
        a.runId,
        input,
        c.guardId,
        reason,
      );
      return { recorded: { patrolScanId: view.id }, flags: [] };
    } catch (e) {
      if (!(e instanceof AppException)) throw e;
      return { rejection: 'patrol_refused', params: { code: e.code } };
    }
  }
}
