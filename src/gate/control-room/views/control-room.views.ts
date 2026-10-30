import { ApiProperty } from '@nestjs/swagger';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { CONTROL_ROOM_KINDS } from '../control-room';
import type { ControlRoomEventRead, PostRead } from '../control-room.service';

/**
 * An event of the control room's channel (ADR 0068): what happened, where,
 * and what it points at — ids and codes only. The source opens in its own
 * screen (an emergency, a lockdown, a blocklist match…).
 */
export class ControlRoomEventView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: CONTROL_ROOM_KINDS, enumName: 'ControlRoomEventKind' })
  kind: string;
  @ApiProperty({
    enum: ['high', 'normal'],
    enumName: 'ControlRoomSeverity',
    description: '`high`: told critically (an SOS, an alarm, a lockdown).',
  })
  severity: string;
  @ApiProperty({
    enum: [
      'emergency',
      'guard_alarm_event',
      'lockdown',
      'blocklist_match',
      'gate_field_exception',
      'patrol_geofence_exit',
      'gate_device',
      'gate_call',
    ],
    enumName: 'ControlRoomSourceType',
  })
  sourceType: string;
  @ApiProperty({ type: String, format: 'uuid' })
  sourceId: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  gateId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  placeId: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  shiftId: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  acknowledgedAt: Date | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  acknowledgedBy: AccountRefView | null;

  static from(r: ControlRoomEventRead): ControlRoomEventView {
    const e = r.event;
    return {
      id: e.id,
      kind: e.kind,
      severity: e.severity,
      sourceType: e.sourceType,
      sourceId: e.sourceId,
      gateId: e.gateId,
      placeId: e.placeId,
      shiftId: e.shiftId,
      occurredAt: e.occurredAt,
      acknowledgedAt: e.acknowledgedAt,
      acknowledgedBy: r.acknowledgedBy ? accountRef(r.acknowledgedBy) : null,
    };
  }
}

class PostShiftView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: AccountRefView })
  guard: AccountRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  startedAt: Date;
  @ApiProperty({
    type: Boolean,
    description: 'The guard wears a guard-down device paired for the shift.',
  })
  alarmPaired: boolean;
}

/** A post at a glance (ADR 0068): a gate, or a zone with a guard on duty. */
export class ControlRoomPostView {
  @ApiProperty({ enum: ['gate', 'zone'], enumName: 'ControlRoomPostKind' })
  kind: string;
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  nameEn: string;
  @ApiProperty({ type: String, nullable: true })
  nameAr: string | null;
  @ApiProperty({ type: PostShiftView, nullable: true })
  shift: PostShiftView | null;
  @ApiProperty({ type: Boolean })
  lockedDown: boolean;
  @ApiProperty({
    type: Number,
    description: 'Field exceptions waiting for the management.',
  })
  openExceptions: number;
  @ApiProperty({ type: Number, description: 'Staff SOS still open there.' })
  openEmergencies: number;

  static from(p: PostRead): ControlRoomPostView {
    return {
      kind: p.kind,
      id: p.id,
      nameEn: p.nameEn,
      nameAr: p.nameAr,
      shift: p.shift
        ? {
            id: p.shift.id,
            guard: accountRef(p.shift.guard),
            startedAt: p.shift.startedAt,
            alarmPaired: p.shift.alarmPaired,
          }
        : null,
      lockedDown: p.lockedDown,
      openExceptions: p.openExceptions,
      openEmergencies: p.openEmergencies,
    };
  }
}
