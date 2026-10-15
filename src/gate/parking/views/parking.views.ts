import { ApiProperty } from '@nestjs/swagger';
import {
  VisitorParkingCancelSide,
  VisitorParkingStatus,
  type VisitorParkingArea,
} from '@prisma/client';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import { reference } from '../../vehicles/vehicle-rules';
import type { StaffParking, StaffSlot } from '../staff-parking.service';
import type { ResidentParking, UnitParking } from '../visitor-parking.service';

export class ParkingSlotRefView {
  @ApiProperty({ type: String, example: 'B2-117' })
  code: string;
  @ApiProperty({ type: String, example: 'Basement 2, row C' })
  place: string;
}

export class VisitorAreaFreeView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  name: string;
  @ApiProperty({
    type: Number,
    description:
      'Spaces free now, never below zero. Read it again before booking.',
  })
  freeSpaces: number;
}

/** A unit's parking (ADR 0045): its own slots, and the visitor areas now. */
export class UnitParkingView {
  @ApiProperty({ type: [ParkingSlotRefView] })
  slots: ParkingSlotRefView[];
  @ApiProperty({ type: [VisitorAreaFreeView] })
  visitorAreas: VisitorAreaFreeView[];

  static from(p: UnitParking): UnitParkingView {
    return {
      slots: p.slots.map((s) => ({ code: s.code, place: s.place })),
      visitorAreas: p.areas.map((a) => ({
        id: a.area.id,
        name: a.area.name,
        freeSpaces: a.freeSpaces,
      })),
    };
  }
}

/** A visitor parking booking as the unit's people see it. */
export class VisitorParkingBookingView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'P-8741' })
  reference: string;
  @ApiProperty({ type: String, format: 'uuid' })
  areaId: string;
  @ApiProperty({ type: String })
  areaName: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  visitorPassId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The booker’s own bookings only (null for the primary looking at another’s), and null 30 days after it ends.',
  })
  visitorName: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ enum: VisitorParkingStatus, enumName: 'VisitorParkingStatus' })
  status: VisitorParkingStatus;
  @ApiProperty({
    enum: VisitorParkingCancelSide,
    enumName: 'VisitorParkingCancelSide',
    nullable: true,
  })
  cancelSide: VisitorParkingCancelSide | null;
  @ApiProperty({ type: String, nullable: true })
  cancelReason: string | null;
  @ApiProperty({ type: Boolean, description: 'The caller made it.' })
  mine: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: ResidentParking): VisitorParkingBookingView {
    const b = r.booking;
    return {
      id: b.id,
      reference: reference('P', b.number),
      areaId: b.areaId,
      areaName: r.areaName,
      visitorPassId: b.visitorPassId,
      visitorName: r.mine ? b.visitorName : null,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      status: b.status,
      cancelSide: b.cancelSide,
      cancelReason: b.cancelReason,
      mine: r.mine,
      createdAt: b.createdAt,
    };
  }
}

export class StaffParkingSlotView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String })
  place: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(s: StaffSlot): StaffParkingSlotView {
    return {
      id: s.slot.id,
      unitId: s.slot.unitId,
      unitCode: s.unitCode,
      code: s.slot.code,
      place: s.slot.place,
      createdAt: s.slot.createdAt,
    };
  }
}

export class VisitorParkingAreaView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  name: string;
  @ApiProperty({ type: Number })
  capacity: number;
  @ApiProperty({
    type: Boolean,
    description: 'False: retired, takes no booking.',
  })
  active: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(a: VisitorParkingArea): VisitorParkingAreaView {
    return {
      id: a.id,
      name: a.name,
      capacity: a.capacity,
      active: a.active,
      createdAt: a.createdAt,
    };
  }
}

/** A visitor booking as the staff see it: the unit, the visitor, the booker. */
export class StaffVisitorParkingBookingView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'P-8741' })
  reference: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String, format: 'uuid' })
  areaId: string;
  @ApiProperty({ type: String })
  areaName: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  visitorPassId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null for a pass’s booking, and 30 days after it ends.',
  })
  visitorName: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({ enum: VisitorParkingStatus, enumName: 'VisitorParkingStatus' })
  status: VisitorParkingStatus;
  @ApiProperty({
    enum: VisitorParkingCancelSide,
    enumName: 'VisitorParkingCancelSide',
    nullable: true,
  })
  cancelSide: VisitorParkingCancelSide | null;
  @ApiProperty({ type: String, nullable: true })
  cancelReason: string | null;
  @ApiProperty({ type: AccountRefView })
  bookedBy: AccountRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(s: StaffParking): StaffVisitorParkingBookingView {
    const b = s.booking;
    return {
      id: b.id,
      reference: reference('P', b.number),
      unitId: b.unitId,
      unitCode: s.unitCode,
      areaId: b.areaId,
      areaName: s.areaName,
      visitorPassId: b.visitorPassId,
      visitorName: b.visitorName,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      status: b.status,
      cancelSide: b.cancelSide,
      cancelReason: b.cancelReason,
      bookedBy: accountRef(s.bookedBy),
      createdAt: b.createdAt,
    };
  }
}
