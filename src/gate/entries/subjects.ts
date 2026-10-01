import { Injectable } from '@nestjs/common';
import type { GateSubjectType, VisitorPass } from '@prisma/client';
import {
  CommunityGatePort,
  type GateEngagement,
  type GateSchedule,
} from '../../community';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';

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
  | 'not_approved';

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

  /** By id, for entries; null when it is not in this compound. */
  async byId(
    tx: TenantTxClient,
    type: GateSubjectType,
    id: string,
  ): Promise<GateSubject | null> {
    if (type === 'visitor_pass') {
      const pass = await tx.visitorPass.findUnique({ where: { id } });
      return pass ? this.pass(tx, pass) : null;
    }
    if (type === 'worker_engagement') {
      const e = await this.community.engagementById(tx, id);
      return e ? this.worker(e) : null;
    }
    return null;
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
    return 'unknown_code';
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
