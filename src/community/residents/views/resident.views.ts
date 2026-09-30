import { ApiProperty } from '@nestjs/swagger';
import {
  AccountStatus,
  IdDocumentType,
  Locale,
  OccupancyType,
} from '@prisma/client';
import {
  erased,
  isErased,
  maskDocument,
  type ErasedAccount,
} from '../../../core/common/http/personal';
import type { ResidentView } from '../residents.types';
import { OccupancyResponse } from './occupancy.views';

export class ResidentUnitView {
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({ enum: OccupancyType, enumName: 'OccupancyType' })
  occupancyType: OccupancyType;
  @ApiProperty({ type: Boolean })
  isPrimary: boolean;
}

/**
 * A resident in a manager's list: contact details and active units; never
 * the document or the birth date. Erased: `{ id, erased: true }`.
 */
export class ResidentListItemView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, required: false })
  fullName?: string | null;
  @ApiProperty({ type: String, nullable: true, required: false })
  phone?: string | null;
  @ApiProperty({ type: String, required: false })
  email?: string | null;
  @ApiProperty({
    enum: AccountStatus,
    enumName: 'AccountStatus',
    required: false,
  })
  status?: AccountStatus;
  @ApiProperty({
    type: [ResidentUnitView],
    required: false,
    description: 'Active occupancies.',
  })
  units?: ResidentUnitView[];
  @ApiProperty({ type: Boolean, enum: [true], required: false })
  erased?: true;

  static from(r: ResidentView): ResidentListItemView | ErasedAccount {
    if (isErased(r)) return erased(r.id);
    return {
      id: r.id,
      fullName: r.fullName,
      phone: r.phone,
      email: r.email,
      status: r.status,
      units: r.occupancies
        .filter((o) => o.status === 'active')
        .map((o) => ({
          unitId: o.unitId,
          unitCode: o.unitCode,
          occupancyType: o.occupancyType,
          isPrimary: o.isPrimary,
        })),
    };
  }
}

/** One resident, for a manager: the document masked, every occupancy. */
export class ResidentDetailView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, required: false })
  fullName?: string | null;
  @ApiProperty({
    enum: IdDocumentType,
    enumName: 'IdDocumentType',
    nullable: true,
    required: false,
  })
  idDocumentType?: IdDocumentType | null;
  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    example: '••••1234',
  })
  idDocumentNumberMasked?: string | null;
  @ApiProperty({ type: String, nullable: true, required: false })
  nationality?: string | null;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    required: false,
  })
  birthDate?: string | null;
  @ApiProperty({ type: String, nullable: true, required: false })
  phone?: string | null;
  @ApiProperty({ type: String, required: false })
  email?: string | null;
  @ApiProperty({
    enum: AccountStatus,
    enumName: 'AccountStatus',
    required: false,
  })
  status?: AccountStatus;
  @ApiProperty({ enum: Locale, enumName: 'Locale', required: false })
  preferredLocale?: Locale;
  @ApiProperty({
    type: [OccupancyResponse],
    required: false,
    description: 'Active and ended, oldest first.',
  })
  occupancies?: OccupancyResponse[];
  @ApiProperty({ type: Boolean, enum: [true], required: false })
  erased?: true;

  static from(r: ResidentView): ResidentDetailView | ErasedAccount {
    if (isErased(r)) return erased(r.id);
    return {
      id: r.id,
      fullName: r.fullName,
      idDocumentType: r.idDocumentType,
      idDocumentNumberMasked: maskDocument(r.idDocumentNumber),
      nationality: r.nationality,
      birthDate: r.birthDate,
      phone: r.phone,
      email: r.email,
      status: r.status,
      preferredLocale: r.preferredLocale,
      occupancies: r.occupancies.map((o) => OccupancyResponse.from(o)),
    };
  }
}
