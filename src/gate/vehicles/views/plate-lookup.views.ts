import { ApiProperty } from '@nestjs/swagger';
import { VehicleType, VisitorPassKind } from '@prisma/client';
import type {
  GuardBooking,
  GuardParking,
} from '../../parking/visitor-parking.service';
import { dayOf, PERMIT_STATUSES, reference } from '../vehicle-rules';
import type {
  PassMatch,
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
];

/** A visitor's parking as the guard sees it: where and when, never who. */
export class GuardParkingView {
  @ApiProperty({ type: String })
  areaName: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;

  static from(p: GuardParking | null): GuardParkingView | null {
    return p && { areaName: p.areaName, startsAt: p.startsAt, endsAt: p.endsAt };
  }
}

export class PlateVehicleView {
  @ApiProperty({
    enum: [...PERMIT_STATUSES],
    enumName: 'VehiclePermitStatus',
    description: 'Pending or active vehicles only; `expires_soon` and `expired` read now.',
  })
  permitStatus: string;
  @ApiProperty({ type: String, nullable: true, description: 'The permit’s last local day.' })
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
  @ApiProperty({ type: Boolean, description: 'The pass lets its visitor in now.' })
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
    description: 'Its visitor parking booking holding now, or the next within two hours.',
  })
  parking: GuardParkingView | null;
}

/** One thing a plate is found on: a unit's vehicle, or a visitor's pass. */
export class PlateMatchView {
  @ApiProperty({ enum: ['vehicle', 'visitor_pass'] })
  kind: 'vehicle' | 'visitor_pass';
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, description: 'As it was typed, tidied.' })
  plate: string;
  @ApiProperty({ type: PlateVehicleView, nullable: true })
  vehicle: PlateVehicleView | null;
  @ApiProperty({ type: PlatePassView, nullable: true })
  pass: PlatePassView | null;

  static from(m: VehicleMatch | PassMatch): PlateMatchView {
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
    };
  }
}

/** What a plate is found on, for the guard (ADR 0045). Never a name. */
export class PlateLookupView {
  @ApiProperty({ type: String, description: 'The plate looked up, tidied.' })
  plate: string;
  @ApiProperty({ type: [PlateMatchView] })
  matches: PlateMatchView[];

  static from(l: PlateLookup): PlateLookupView {
    return { plate: l.plate, matches: l.matches.map((m) => PlateMatchView.from(m)) };
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
    description: 'For a visitor pass: the guard verifies the pass, and sees this booking there.',
  })
  hasPass: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'For a booking without a pass only: the name the household gave.',
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
