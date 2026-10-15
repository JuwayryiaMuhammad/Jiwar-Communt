import { ApiProperty } from '@nestjs/swagger';
import { VehicleRemovalSide, VehicleStatus, VehicleType } from '@prisma/client';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import type { ResidentVehicle } from '../vehicles.service';
import type {
  StaffVehicle,
  StaffVehicleDetail,
} from '../staff-vehicles.service';
import { dayOf, PERMIT_STATUSES, reference } from '../vehicle-rules';
import type { VehicleSettingsView } from '../vehicle-settings.service';

const PERMIT_STATUS = {
  enum: [...PERMIT_STATUSES],
  enumName: 'VehiclePermitStatus',
  description:
    '`expires_soon` within 30 days of `permitValidUntil`, `expired` after it: read when asked, never stored. `removed` only on staff views.',
} as const;

/** A unit's vehicle as its people see it (ADR 0045). */
export class VehicleView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'V-2048' })
  reference: string;
  @ApiProperty({ type: String, description: 'As typed, tidied (ADR 0043).' })
  plate: string;
  @ApiProperty({ type: String })
  makeAndModel: string;
  @ApiProperty({ type: String })
  color: string;
  @ApiProperty({ enum: VehicleType, enumName: 'VehicleType' })
  type: VehicleType;
  @ApiProperty(PERMIT_STATUS)
  permitStatus: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The last local day the permit is valid, `YYYY-MM-DD`.',
  })
  permitValidUntil: string | null;
  @ApiProperty({ type: String, nullable: true })
  stickerNumber: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'From the closed list `vehicleReject`, while rejected.',
  })
  rejectionReason: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A presigned URL, valid for minutes: never cache it.',
  })
  licencePhotoUrl: string | null;
  @ApiProperty({
    type: Boolean,
    description:
      'The caller registered it or is the unit’s primary: may edit and remove it.',
  })
  canManage: boolean;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: ResidentVehicle): VehicleView {
    const v = r.vehicle;
    return {
      id: v.id,
      reference: reference('V', v.number),
      plate: v.plate,
      makeAndModel: v.makeAndModel,
      color: v.color,
      type: v.type,
      permitStatus: r.permitStatus,
      permitValidUntil: dayOf(v.permitValidUntil),
      stickerNumber: v.stickerNumber,
      rejectionReason: v.rejectionReason,
      licencePhotoUrl: r.photo?.url ?? null,
      canManage: r.canManage,
      createdAt: v.createdAt,
    };
  }
}

/** A vehicle as the staff see it in a list. */
export class StaffVehicleView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'V-2048' })
  reference: string;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ type: String })
  plate: string;
  @ApiProperty({ type: String })
  makeAndModel: string;
  @ApiProperty({ type: String })
  color: string;
  @ApiProperty({ enum: VehicleType, enumName: 'VehicleType' })
  type: VehicleType;
  @ApiProperty({ enum: VehicleStatus, enumName: 'VehicleStatus' })
  status: VehicleStatus;
  @ApiProperty(PERMIT_STATUS)
  permitStatus: string;
  @ApiProperty({ type: String, nullable: true })
  permitValidUntil: string | null;
  @ApiProperty({ type: String, nullable: true })
  stickerNumber: string | null;
  @ApiProperty({
    type: Number,
    description:
      'Name it when approving or rejecting: a plate changed since is VEHICLE_CHANGED.',
  })
  version: number;
  @ApiProperty({ type: AccountRefView })
  registeredBy: AccountRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(s: StaffVehicle): StaffVehicleView {
    const v = s.vehicle;
    return {
      id: v.id,
      reference: reference('V', v.number),
      unitId: v.unitId,
      unitCode: s.unitCode,
      plate: v.plate,
      makeAndModel: v.makeAndModel,
      color: v.color,
      type: v.type,
      status: v.status,
      permitStatus: s.permitStatus,
      permitValidUntil: dayOf(v.permitValidUntil),
      stickerNumber: v.stickerNumber,
      version: v.version,
      registeredBy: accountRef(s.registeredBy),
      createdAt: v.createdAt,
    };
  }
}

/** One vehicle for the staff: its licence photo and who decided. */
export class StaffVehicleDetailView extends StaffVehicleView {
  @ApiProperty({ type: String, nullable: true })
  rejectionReason: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A presigned URL, valid for minutes.',
  })
  licencePhotoUrl: string | null;
  @ApiProperty({ type: AccountRefView, nullable: true })
  decidedBy: AccountRefView | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  removedAt: Date | null;
  @ApiProperty({
    enum: VehicleRemovalSide,
    enumName: 'VehicleRemovalSide',
    nullable: true,
  })
  removalSide: VehicleRemovalSide | null;
  @ApiProperty({ type: String, nullable: true })
  removalReason: string | null;
  @ApiProperty({
    type: AccountRefView,
    nullable: true,
    description: 'Null for the system’s removal.',
  })
  removedBy: AccountRefView | null;

  static detail(d: StaffVehicleDetail): StaffVehicleDetailView {
    const v = d.vehicle;
    return {
      ...StaffVehicleView.from(d),
      rejectionReason: v.rejectionReason,
      licencePhotoUrl: d.photo?.url ?? null,
      decidedBy: d.decidedBy && accountRef(d.decidedBy),
      decidedAt: v.decidedAt,
      removedAt: v.removedAt,
      removalSide: v.removalSide,
      removalReason: v.removalReason,
      removedBy: d.removedBy && accountRef(d.removedBy),
    };
  }
}

export class VehicleSettingsResponse {
  @ApiProperty({
    type: Number,
    description: 'Pending or active vehicles per unit.',
  })
  maxVehiclesPerUnit: number;
  @ApiProperty({
    type: Number,
    description: 'The longest visitor parking booking, in hours.',
  })
  visitorParkingMaxHours: number;
  @ApiProperty({
    type: Number,
    description:
      'Visitor parking bookings a unit holds at once (not yet ended).',
  })
  maxActiveVisitorParkingBookings: number;

  static from(s: VehicleSettingsView): VehicleSettingsResponse {
    return { ...s };
  }
}
