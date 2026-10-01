import { Injectable } from '@nestjs/common';
import type { FieldError } from '../core/common/errors';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import type { Capabilities } from './capabilities/capabilities';
import { CapabilitiesService } from './capabilities/capabilities.service';
import {
  HouseholdAuthority,
  isPrimary,
} from './households/household-authority';
import { lockUnits } from './units/unit-lock';
import {
  checkSchedule,
  isWithinSchedule,
  type WorkerSchedule,
} from './workers/schedule';

/** A weekly schedule: days 0–6 and windows in the compound's time zone. */
export type GateSchedule = WorkerSchedule;

/**
 * What the gate domain reads from the community domain (ADR 0015, 0028),
 * and nothing else: units, who may do what on a unit (capabilitiesFor), the
 * household's authority and the schedule rules. Every method takes the
 * gate's transaction, so the answer is consistent with the gate's write.
 */
@Injectable()
export class CommunityGatePort {
  constructor(
    private readonly capabilities: CapabilitiesService,
    private readonly household: HouseholdAuthority,
  ) {}

  /** An account's capabilities on a unit, or null when it has no place there. */
  placeIn(
    tx: TenantTxClient,
    accountId: string,
    unitId: string,
  ): Promise<Capabilities | null> {
    return this.capabilities.placeOf(tx, accountId, unitId);
  }

  isPrimary(
    tx: TenantTxClient,
    unitId: string,
    accountId: string,
  ): Promise<boolean> {
    return isPrimary(tx, unitId, accountId);
  }

  /** The caller runs the unit's household: its primary or a `household` delegate. */
  async requireHousehold(tx: TenantTxClient, unitId: string): Promise<void> {
    await this.household.require(tx, unitId, 'household');
  }

  /** Serializes what hangs off a unit (the pass cap) for this transaction. */
  lockUnit(tx: TenantTxClient, unitId: string): Promise<void> {
    return lockUnits(tx, [unitId]);
  }

  /** A visit schedule: the worker rules for a non-live-in schedule. */
  checkSchedule(
    raw: GateSchedule | undefined,
    fields: FieldError[],
  ): GateSchedule {
    return checkSchedule('hourly', raw, fields);
  }

  isWithinSchedule(
    schedule: GateSchedule,
    instant: Date,
    timeZone: string,
  ): boolean {
    return isWithinSchedule(schedule, instant, timeZone);
  }
}
