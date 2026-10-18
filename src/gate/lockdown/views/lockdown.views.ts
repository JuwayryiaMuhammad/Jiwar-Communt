import { ApiProperty } from '@nestjs/swagger';
import {
  accountRef,
  AccountRefView,
  firstNameRef,
  FirstNameRefView,
} from '../../../core/common/http/personal';
import { REASON_CODES } from '../../../core/common/reasons';
import { scopeOf } from '../lockdown-core';
import type { LockdownRecord, OverrideRecord } from '../lockdown.service';

const SCOPES = ['gate', 'all'] as const;

export class LockdownGateView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  name: string;
}

/**
 * A lockdown as a guard on shift sees it (ADR 0053): where, why, since
 * when, and the guard who started it by first name.
 */
export class GuardLockdownView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: SCOPES, enumName: 'LockdownScope' })
  scope: (typeof SCOPES)[number];
  @ApiProperty({
    type: LockdownGateView,
    nullable: true,
    description: 'Null for every gate.',
  })
  gate: LockdownGateView | null;
  @ApiProperty({
    enum: [...REASON_CODES.gateLockdownStart],
    enumName: 'GateLockdownStart',
  })
  reasonCode: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startedAt: Date;
  @ApiProperty({ type: FirstNameRefView })
  startedBy: FirstNameRefView;

  static from(r: LockdownRecord): GuardLockdownView {
    const l = r.lockdown;
    return {
      id: l.id,
      scope: scopeOf(l),
      gate: r.gate && { ...r.gate },
      reasonCode: l.reasonCode,
      startedAt: l.startedAt,
      startedBy: firstNameRef(r.startedBy),
    };
  }
}

/** An emergency vehicle let through a locked gate. */
export class LockdownOverrideView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  lockdownId: string;
  @ApiProperty({ type: LockdownGateView })
  gate: LockdownGateView;
  @ApiProperty({
    enum: [...REASON_CODES.gateLockdownOverride],
    enumName: 'GateLockdownOverride',
  })
  reasonCode: string;
  @ApiProperty({ type: AccountRefView, description: 'The guard.' })
  guard: AccountRefView;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  emergencyId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  gateServiceRequestId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt: Date;

  static from(r: OverrideRecord): LockdownOverrideView {
    const o = r.override;
    return {
      id: o.id,
      lockdownId: o.lockdownId,
      gate: { ...r.gate },
      reasonCode: o.kind,
      guard: accountRef(r.guard),
      emergencyId: o.emergencyId,
      gateServiceRequestId: o.gateServiceRequestId,
      occurredAt: o.occurredAt,
    };
  }
}

/**
 * A lockdown as the management sees it (ADR 0053): who started and ended
 * it by full name, the end's code and note, and the overrides.
 */
export class StaffLockdownView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: SCOPES, enumName: 'LockdownScope' })
  scope: (typeof SCOPES)[number];
  @ApiProperty({ type: LockdownGateView, nullable: true })
  gate: LockdownGateView | null;
  @ApiProperty({
    enum: [...REASON_CODES.gateLockdownStart],
    enumName: 'GateLockdownStart',
  })
  reasonCode: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startedAt: Date;
  @ApiProperty({ type: AccountRefView })
  startedBy: AccountRefView;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt: Date | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  endedBy: AccountRefView | null;
  @ApiProperty({
    enum: [...REASON_CODES.gateLockdownEnd],
    enumName: 'GateLockdownEnd',
    nullable: true,
  })
  endReason: string | null;
  @ApiProperty({ type: String, nullable: true })
  endNote: string | null;
  @ApiProperty({ type: [LockdownOverrideView] })
  overrides: LockdownOverrideView[];

  static from(r: LockdownRecord): StaffLockdownView {
    const l = r.lockdown;
    return {
      id: l.id,
      scope: scopeOf(l),
      gate: r.gate && { ...r.gate },
      reasonCode: l.reasonCode,
      startedAt: l.startedAt,
      startedBy: accountRef(r.startedBy),
      endedAt: l.endedAt,
      endedBy: r.endedBy && accountRef(r.endedBy),
      endReason: l.endReason,
      endNote: l.endNote,
      overrides: r.overrides.map((o) => LockdownOverrideView.from(o)),
    };
  }
}
