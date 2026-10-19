import { ApiProperty } from '@nestjs/swagger';
import { VehicleType, VisitorPassKind } from '@prisma/client';
import type {
  GuardBooking,
  GuardParking,
} from '../../parking/visitor-parking.service';
import { dayOf, PERMIT_STATUSES, reference } from '../vehicle-rules';
import { permitReference } from '../../permits/permit-core';
import type {
  PassMatch,
  PermitMatch,
  PlateLookup,
  VehicleMatch,
} from '../plate-lookup.service';

/** Why a visitor pass does not let its visitor in now. */
const PASS_REFUSALS = [
  'not_yet_valid',
  'expired',
  'outside_schedule',
  'host_inactive',
  'used',
  'cancelled',
  // Lockdown and the blocklist (ADR 0053).
  'lockdown_active',
  'entry_blocked',
];

/** Why a permit does not let its truck or guest in now (ADR 0049). */
const PERMIT_REFUSALS = [
  'not_yet_valid',
  'expired',
  'not_approved',
  'cancelled',
  'revoked',
  'outside_work_hours',
  'day_off',
  'guest_removed',
  // Lockdown and the blocklist (ADR 0053).
  'lockdown_active',
  'entry_blocked',
];

/** A move's truck or an event guest's car (ADR 0049): never a name. */
export class PlatePermitView {
  @ApiProperty({ type: String, format: 'uuid' })
  permitId: string;
  @ApiProperty({ type: String, example: 'M-0007' })
  reference: string;
  @ApiProperty({ enum: ['move', 'event'] })
  permitKind: 'move' | 'event';
  @ApiProperty({
    enum: ['move_permit', 'event_guest'],
    description: 'Record the entry against `subjectType` and `subjectId`.',
  })
  subjectType: 'move_permit' | 'event_guest';
  @ApiProperty({ type: String, format: 'uuid' })
  subjectId: string;
  @ApiProperty({ type: Boolean, description: 'The permit lets them in now.' })
  valid: boolean;
  @ApiProperty({ enum: PERMIT_REFUSALS, nullable: true })
  refusal: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
}

/** A visitor's parking as the guard sees it: where and when, never who. */
export class GuardParkingView {
  @ApiProperty({ type: String })
  areaName: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;

  static from(p: GuardParking | null): GuardParkingView | null {
    return (
      p && { areaName: p.areaName, startsAt: p.startsAt, endsAt: p.endsAt }
    );
  }
}

export class PlateVehicleView {
  @ApiProperty({
    enum: [...PERMIT_STATUSES],
    enumName: 'VehiclePermitStatus',
    description:
      'Pending or active vehicles only; `expires_soon` and `expired` read now.',
  })
  permitStatus: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The permit’s last local day.',
  })
  permitValidUntil: string | null;
  @ApiProperty({ type: String, nullable: true })
  stickerNumber: string | null;
  @ApiProperty({ enum: VehicleType, enumName: 'VehicleType' })
  type: VehicleType;
  @ApiProperty({ type: String })
  color: string;
  @ApiProperty({ type: String })
  makeAndModel: string;
}

export class PlatePassView {
  @ApiProperty({ enum: VisitorPassKind, enumName: 'VisitorPassKind' })
  passKind: VisitorPassKind;
  @ApiProperty({
    type: Boolean,
    description: 'The pass lets its visitor in now.',
  })
  valid: boolean;
  @ApiProperty({
    enum: PASS_REFUSALS,
    nullable: true,
    description: 'Why not, when it does not.',
  })
  refusal: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  validFrom: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  validUntil: Date;
  @ApiProperty({
    type: GuardParkingView,
    nullable: true,
    description:
      'Its visitor parking booking holding now, or the next within two hours.',
  })
  parking: GuardParkingView | null;
}

/**
 * One thing a plate is found on: a unit's vehicle, a visitor's pass, or a
 * permit's truck or guest car (ADR 0049).
 */
export class PlateMatchView {
  @ApiProperty({ enum: ['vehicle', 'visitor_pass', 'unit_permit'] })
  kind: 'vehicle' | 'visitor_pass' | 'unit_permit';
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, description: 'As it was typed, tidied.' })
  plate: string;
  @ApiProperty({ type: PlateVehicleView, nullable: true })
  vehicle: PlateVehicleView | null;
  @ApiProperty({ type: PlatePassView, nullable: true })
  pass: PlatePassView | null;
  @ApiProperty({ type: PlatePermitView, nullable: true })
  permit: PlatePermitView | null;

  static from(m: VehicleMatch | PassMatch | PermitMatch): PlateMatchView {
    if (m.kind === 'unit_permit')
      return {
        kind: 'unit_permit',
        unitCode: m.unitCode,
        plate: m.plate,
        vehicle: null,
        pass: null,
        permit: {
          permitId: m.permit.id,
          reference: permitReference(m.permit.kind, m.permit.number),
          permitKind: m.permit.kind as 'move' | 'event',
          subjectType: m.subjectType,
          subjectId: m.subjectId,
          valid: m.refusal === null,
          refusal: m.refusal,
          startsAt: m.permit.startsAt,
          endsAt: m.permit.endsAt,
        },
      };
    if (m.kind === 'vehicle') {
      const v = m.vehicle;
      return {
        kind: 'vehicle',
        unitCode: m.unitCode,
        plate: v.plate,
        vehicle: {
          permitStatus: m.permitStatus,
          permitValidUntil: dayOf(v.permitValidUntil),
          stickerNumber: v.stickerNumber,
          type: v.type,
          color: v.color,
          makeAndModel: v.makeAndModel,
        },
        pass: null,
        permit: null,
      };
    }
    return {
      kind: 'visitor_pass',
      unitCode: m.unitCode,
      plate: m.plate,
      vehicle: null,
      pass: {
        passKind: m.pass.kind,
        valid: m.refusal === null,
        refusal: m.refusal,
        validFrom: m.pass.validFrom,
        validUntil: m.pass.validUntil,
        parking: GuardParkingView.from(m.parking),
      },
      permit: null,
    };
  }
}

/** What a plate is found on, for the guard (ADR 0045). Never a name. */
/** A live blocklist entry for the plate (ADR 0053). */
export class PlateBlocklistView {
  @ApiProperty({ type: String, format: 'uuid' })
  entryId: string;
  @ApiProperty({ enum: ['ban', 'watch'], enumName: 'BlocklistKind' })
  kind: 'ban' | 'watch';
}

/** A service vehicle inside now with the plate (ADR 0056): record its exit. */
export class PlateServiceVehicleView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: ['tanker', 'waste', 'delivery', 'other'],
    enumName: 'ServiceVehicleKind',
  })
  kind: string;
  @ApiProperty({ type: String })
  company: string;
  @ApiProperty({ type: String, format: 'date-time' })
  enteredAt: Date;
}

export class PlateLookupView {
  @ApiProperty({ type: String, description: 'The plate looked up, tidied.' })
  plate: string;
  @ApiProperty({ type: [PlateMatchView] })
  matches: PlateMatchView[];
  @ApiProperty({
    type: [PlateServiceVehicleView],
    description:
      'Service vehicles inside now with the plate (ADR 0056): `POST /gate/service-vehicles/{id}/exit` records the exit. Empty for none.',
  })
  serviceVehicles: PlateServiceVehicleView[];
  @ApiProperty({
    type: [PlateBlocklistView],
    description:
      'The plate on the blocklist (ADR 0053): a `ban` refuses whoever it names (`entry_blocked`), a `watch` only says so. The management is told. Empty for none.',
  })
  blocklist: PlateBlocklistView[];

  static from(l: PlateLookup): PlateLookupView {
    return {
      plate: l.plate,
      matches: l.matches.map((m) => PlateMatchView.from(m)),
      serviceVehicles: l.serviceVehicles.map((v) => ({ ...v })),
      blocklist: l.blocklist.map((b) => ({ ...b })),
    };
  }
}

/** A visitor booking at the gate: the unit, where and when. */
export class GuardVisitorParkingView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'P-8741' })
  reference: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String })
  areaName: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({
    type: Boolean,
    description:
      'For a visitor pass: the guard verifies the pass, and sees this booking there.',
  })
  hasPass: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'For a booking without a pass only: the name the household gave.',
  })
  visitorName: string | null;

  static from(b: GuardBooking): GuardVisitorParkingView {
    return {
      id: b.booking.id,
      reference: reference('P', b.booking.number),
      unitCode: b.unitCode,
      areaName: b.areaName,
      startsAt: b.booking.startsAt,
      endsAt: b.booking.endsAt,
      hasPass: b.booking.visitorPassId !== null,
      visitorName: b.booking.visitorPassId ? null : b.booking.visitorName,
    };
  }
}
