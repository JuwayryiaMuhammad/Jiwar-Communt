import { Injectable } from '@nestjs/common';
import type {
  GateApprovalRequest,
  GateSubjectType,
  PermitGuest,
  PermitWorker,
  UnitPermit,
  VisitorPass,
} from '@prisma/client';
import {
  CommunityGatePort,
  type GateEngagement,
  type GateSchedule,
} from '../../community';
import { localParts } from '../../core/common/slots/day-slots';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { workRules, workTimeRefusal } from '../permits/permit-rules';

/** Guests may come this long before an event starts (ADR 0049). */
export const EVENT_EARLY_MS = 30 * 60_000;

/** Why a code or a subject does not let someone in right now. */
export type Refusal =
  | 'unknown_code'
  | 'not_yet_valid'
  | 'expired'
  | 'outside_schedule'
  | 'host_inactive'
  | 'used'
  | 'cancelled'
  | 'suspended'
  | 'ended'
  | 'banned'
  | 'not_approved'
  // A resident's entry QR (ADR 0031).
  | 'expired_qr'
  | 'not_resident'
  | 'account_inactive'
  | 'revoked'
  // Permits (ADR 0049): the compound's work hours and days off, the ID's
  // last four, someone taken off the permit.
  | 'outside_work_hours'
  | 'day_off'
  | 'id_mismatch'
  | 'worker_removed'
  | 'guest_removed'
  // The gate is locked down (ADR 0053): nobody but a resident comes in.
  | 'lockdown_active'
  // A ban on the blocklist (ADR 0053): the guard reads the list, never why.
  | 'entry_blocked';

/** Who comes through the gate, resolved in this compound (ADR 0028). */
export interface GateSubject {
  type: GateSubjectType;
  id: string;
  unitId: string;
  unitCode: string;
  /** The pass kind, the worker's capacity, or the request kind. */
  kind: string;
  partySize: number;
  visitorDetailsId: string | null;
  /** Workers only: what the guard may see (ADR 0028 PII table). */
  workerName: string | null;
  pass?: VisitorPass;
  engagement?: GateEngagement;
  /** A visitor or delivery let in on a household's approval. */
  request?: GateApprovalRequest;
  /** A permit's subject (ADR 0049): the permit, and its worker or guest. */
  permit?: UnitPermit;
  permitWorker?: PermitWorker;
  guest?: PermitGuest;
}

/**
 * Resolves gate subjects and says whether they may come in at an instant.
 * Passes are the gate's own; workers come from the community domain
 * through its port. One-time passes are used by their first entry.
 */
@Injectable()
export class GateSubjects {
  constructor(private readonly community: CommunityGatePort) {}

  async pass(tx: TenantTxClient, pass: VisitorPass): Promise<GateSubject> {
    return {
      type: 'visitor_pass',
      id: pass.id,
      unitId: pass.unitId,
      unitCode: await this.community.unitCode(tx, pass.unitId),
      kind: pass.kind,
      partySize: pass.partySize,
      visitorDetailsId: pass.visitorDetailsId,
      workerName: null,
      pass,
    };
  }

  async request(
    tx: TenantTxClient,
    r: GateApprovalRequest,
  ): Promise<GateSubject> {
    return {
      type: 'gate_request',
      id: r.id,
      unitId: r.unitId,
      unitCode: await this.community.unitCode(tx, r.unitId),
      kind: r.kind,
      partySize: r.partySize,
      visitorDetailsId: r.visitorDetailsId,
      workerName: null,
      request: r,
    };
  }

  worker(e: GateEngagement): GateSubject {
    return {
      type: 'worker_engagement',
      id: e.engagementId,
      unitId: e.unitId,
      unitCode: e.unitCode,
      kind: e.capacity,
      partySize: 1,
      visitorDetailsId: null,
      workerName: e.workerName,
      engagement: e,
    };
  }

  /**
   * A permit's subject (ADR 0049): a contractor worker of a works permit, a
   * guest of an event, or a move's truck (the permit itself). One person
   * (one truck) each; no name here: the guard reads it on the permit.
   */
  async permitSubject(
    tx: TenantTxClient,
    type: 'permit_worker' | 'event_guest' | 'move_permit',
    id: string,
  ): Promise<GateSubject | null> {
    let permitId = id;
    let permitWorker: PermitWorker | undefined;
    let guest: PermitGuest | undefined;
    if (type === 'permit_worker') {
      const w = await tx.permitWorker.findUnique({ where: { id } });
      if (!w) return null;
      permitWorker = w;
      permitId = w.permitId;
    } else if (type === 'event_guest') {
      const g = await tx.permitGuest.findUnique({ where: { id } });
      if (!g) return null;
      guest = g;
      permitId = g.permitId;
    }
    const permit = await tx.unitPermit.findUnique({ where: { id: permitId } });
    if (!permit || (type === 'move_permit' && permit.kind !== 'move'))
      return null;
    return {
      type,
      id,
      unitId: permit.unitId,
      unitCode: await this.community.unitCode(tx, permit.unitId),
      kind:
        type === 'permit_worker'
          ? 'contractor'
          : type === 'event_guest'
            ? 'event_guest'
            : 'move',
      partySize: 1,
      visitorDetailsId: null,
      workerName: null,
      permit,
      ...(permitWorker ? { permitWorker } : {}),
      ...(guest ? { guest } : {}),
    };
  }

  /** By id, for entries; null when it is not in this compound. */
  async byId(
    tx: TenantTxClient,
    type: GateSubjectType,
    id: string,
  ): Promise<GateSubject | null> {
    switch (type) {
      case 'visitor_pass': {
        const pass = await tx.visitorPass.findUnique({ where: { id } });
        return pass ? this.pass(tx, pass) : null;
      }
      case 'worker_engagement': {
        const e = await this.community.engagementById(tx, id);
        return e ? this.worker(e) : null;
      }
      case 'gate_request': {
        const r = await tx.gateApprovalRequest.findUnique({ where: { id } });
        return r ? this.request(tx, r) : null;
      }
      case 'permit_worker':
      case 'event_guest':
      case 'move_permit':
        return this.permitSubject(tx, type, id);
      default:
        return unknownType(type);
    }
  }

  /** Null when the subject may come in at `at`, else why not. */
  async refusal(
    tx: TenantTxClient,
    s: GateSubject,
    at: Date,
    timeZone: string,
  ): Promise<Refusal | null> {
    if (s.pass) return this.passRefusal(tx, s.pass, at, timeZone);
    if (s.engagement) return this.workerRefusal(s.engagement, at, timeZone);
    if (s.permit) return this.permitRefusal(tx, s, at, timeZone);
    return 'unknown_code';
  }

  /**
   * A permit's subject (ADR 0049): the permit approved and in its window
   * (guests may come half an hour early), the worker or guest still on it;
   * for a worker and a truck, the compound's work days and hours as they
   * stand at `at`, and a worker within the permit's own daily hours too.
   * The last four of a worker's ID are checked by the entry, after this.
   */
  private async permitRefusal(
    tx: TenantTxClient,
    s: GateSubject,
    at: Date,
    timeZone: string,
  ): Promise<Refusal | null> {
    const p = s.permit!;
    if (p.status === 'pending' || p.status === 'rejected')
      return 'not_approved';
    if (p.status === 'cancelled') return 'cancelled';
    if (p.status === 'revoked') return 'revoked';
    if (p.status === 'used') return 'used';
    const early = s.type === 'event_guest' ? EVENT_EARLY_MS : 0;
    if (at.getTime() < p.startsAt.getTime() - early) return 'not_yet_valid';
    if (at.getTime() >= p.endsAt.getTime()) return 'expired';
    if (s.permitWorker && (s.permitWorker.removedAt || s.permitWorker.purgedAt))
      return 'worker_removed';
    if (s.guest && (s.guest.removedAt || s.guest.purgedAt))
      return 'guest_removed';
    if (s.type === 'event_guest') return null;
    const rules = workRules(
      await tx.permitSettings.findUniqueOrThrow({
        where: { tenantId: p.tenantId },
      }),
    );
    const compound = workTimeRefusal(rules, at, timeZone);
    if (compound) return compound;
    if (s.type === 'permit_worker') {
      const { minute } = localParts(at, timeZone);
      if (minute < p.dailyFrom! || minute >= p.dailyTo!)
        return 'outside_work_hours';
    }
    return null;
  }

  private async passRefusal(
    tx: TenantTxClient,
    p: VisitorPass,
    at: Date,
    timeZone: string,
  ): Promise<Refusal | null> {
    if (p.status === 'used') return 'used';
    if (p.status === 'cancelled') return 'cancelled';
    if (p.status === 'expired') return 'expired';
    // The pass follows its host: no longer allowed to invite, no visitors.
    const host = await this.community.placeIn(tx, p.hostAccountId, p.unitId);
    if (!host?.visitorsInvite) return 'host_inactive';
    if (at < p.validFrom) return 'not_yet_valid';
    if (at >= p.validUntil) return 'expired';
    if (
      p.kind === 'recurring' &&
      !this.community.isWithinSchedule(
        p.schedule as unknown as GateSchedule,
        at,
        timeZone,
      )
    )
      return 'outside_schedule';
    return null;
  }

  private workerRefusal(
    e: GateEngagement,
    at: Date,
    timeZone: string,
  ): Refusal | null {
    if (e.banned) return 'banned';
    if (e.status === 'suspended') return 'suspended';
    if (e.status !== 'active') return 'ended';
    if (e.validUntil && at >= e.validUntil) return 'expired';
    if (!this.community.isWithinSchedule(e.schedule, at, timeZone))
      return 'outside_schedule';
    return null;
  }
}

/** A subject type this code does not know: a programming error, never a 404. */
export function unknownType(type: never): never {
  throw new Error(`Unknown gate subject type ${String(type)}`);
}
