import { ApiProperty } from '@nestjs/swagger';
import { IdDocumentType, UnitPermitKind } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDate,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PLATE_MAX } from '../../../core/common/vehicle-plate';
import { PageQueryDto } from '../../../core/common/http/list';
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';
import { LOCAL_DATE } from '../../vehicles/dto/vehicles.dto';
import { PERMIT_LIMITS } from '../permit-rules';
import { PERMIT_VIEW_STATUSES } from '../views/permit.views';
import { PermitHoursDto } from './permit-settings.dto';
import { ToInstant } from '../../../core/common/validation/instant';

export const CONTRACTOR_COMPANY = { min: 1, max: 120 } as const;
export const PERMIT_DESCRIPTION = { min: 1, max: 1000 } as const;
export const PERSON_NAME = { min: 2, max: 120 } as const;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

export class CreateWorksPermitDto {
  @ApiProperty({
    enum: [...REASON_CODES.permitWorkType],
    enumName: 'PermitWorkType',
  })
  @IsIn(
    REASON_CODES.permitWorkType,
    withParams({ allowed: [...REASON_CODES.permitWorkType] }),
  )
  workType: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    example: '2026-11-01',
    description:
      'The first local day: from today, at most 90 days ahead (DAY_OUT_OF_RANGE).',
  })
  @IsString()
  @Matches(LOCAL_DATE)
  startsOn: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    example: '2026-11-20',
    description:
      'The last local day: not before `startsOn` (ENDS_BEFORE_START), 180 days at most (PERIOD_TOO_LONG); the period holds a work day (NOT_A_WORK_DAY).',
  })
  @IsString()
  @Matches(LOCAL_DATE)
  endsOn: string;

  @ApiProperty({
    type: PermitHoursDto,
    description:
      'Every day of the period, inside the compound’s work hours (OUTSIDE_WORK_HOURS, params.from and params.to).',
  })
  @ValidateNested()
  @Type(() => PermitHoursDto)
  dailyHours: PermitHoursDto;

  @ApiProperty({
    type: String,
    minLength: CONTRACTOR_COMPANY.min,
    maxLength: CONTRACTOR_COMPANY.max,
    example: 'Cairo Finishing Co.',
  })
  @Transform(trim)
  @IsString()
  @Length(
    CONTRACTOR_COMPANY.min,
    CONTRACTOR_COMPANY.max,
    withParams(CONTRACTOR_COMPANY),
  )
  contractorCompany: string;

  @ApiProperty({
    type: String,
    minLength: PERMIT_DESCRIPTION.min,
    maxLength: PERMIT_DESCRIPTION.max,
    example: 'New kitchen tiles and painting the living room.',
  })
  @IsString()
  @Length(
    PERMIT_DESCRIPTION.min,
    PERMIT_DESCRIPTION.max,
    withParams(PERMIT_DESCRIPTION),
  )
  description: string;
}

export class UnitPermitsQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: UnitPermitKind,
    enumName: 'UnitPermitKind',
    required: false,
  })
  @IsOptional()
  @IsEnum(
    UnitPermitKind,
    withParams({ allowed: Object.values(UnitPermitKind) }),
  )
  kind?: UnitPermitKind;

  @ApiProperty({
    enum: PERMIT_VIEW_STATUSES,
    enumName: 'PermitViewStatus',
    required: false,
  })
  @IsOptional()
  @IsIn(
    PERMIT_VIEW_STATUSES,
    withParams({ allowed: [...PERMIT_VIEW_STATUSES] }),
  )
  status?: (typeof PERMIT_VIEW_STATUSES)[number];
}

export class CancelPermitDto {
  @ApiProperty({
    type: String,
    required: false,
    description: 'From the closed list `unitPermitCancel`; optional.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class AddPermitWorkerDto {
  @ApiProperty({
    type: String,
    minLength: PERSON_NAME.min,
    maxLength: PERSON_NAME.max,
    example: 'Mahmoud Ali Hassan',
    description: 'As on their ID.',
  })
  @Transform(trim)
  @IsString()
  @Length(PERSON_NAME.min, PERSON_NAME.max, withParams(PERSON_NAME))
  fullName: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'A finalized `contractor_photo` of the caller: their face, shown to the guard (FILE_NOT_AVAILABLE).',
  })
  @IsUUID()
  photoFileId: string;

  @ApiProperty({ enum: IdDocumentType, enumName: 'IdDocumentType' })
  @IsEnum(
    IdDocumentType,
    withParams({ allowed: Object.values(IdDocumentType) }),
  )
  idType: IdDocumentType;

  @ApiProperty({
    type: String,
    example: '4821',
    description:
      'The last four characters of the ID’s number: four digits for a national ID, four letters or digits for a passport (INVALID_FORMAT). Never the whole number, never a scan. Stored only as a keyed hash: nobody sees it again; the guard types it from the card.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z0-9]{4}$/)
  idLast4: string;
}

export const ITEMS_DESCRIPTION = { min: 1, max: 1000 } as const;
export const ITEM_NAME = { min: 1, max: 80 } as const;
export const ITEM_QUANTITY = { min: 1, max: 9999 } as const;
export const EVENT_TITLE = { min: 1, max: 120 } as const;
const MAX_ITEMS = 30;

const PLATE_TEXT =
  'Arabic letters, Latin letters, Western or Arabic-Indic digits and spaces; tidied (trimmed, single spaces, Latin upper case), at most 12 characters after that (INVALID_FORMAT, params.maxLength).';

export class CreateMovePermitDto {
  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    example: '2026-11-05',
    description:
      'The local day: from today, at most 90 days ahead (DAY_OUT_OF_RANGE); a work day of the compound, not a day off (NOT_A_WORK_DAY).',
  })
  @IsString()
  @Matches(LOCAL_DATE)
  date: string;

  @ApiProperty({
    type: PermitHoursDto,
    description:
      'Inside the compound’s work hours (OUTSIDE_WORK_HOURS, params.from and params.to); not over already (INVALID_VALUE on `window.to`).',
  })
  @ValidateNested()
  @Type(() => PermitHoursDto)
  window: PermitHoursDto;

  @ApiProperty({
    type: String,
    maxLength: PLATE_MAX,
    example: 'ن ق ل ٤٥٦',
    description: `The truck’s plate. ${PLATE_TEXT}`,
  })
  @IsString()
  truckPlate: string;

  @ApiProperty({
    type: String,
    minLength: ITEMS_DESCRIPTION.min,
    maxLength: ITEMS_DESCRIPTION.max,
    example: 'Two sofas, a fridge and twenty boxes',
  })
  @IsString()
  @Length(
    ITEMS_DESCRIPTION.min,
    ITEMS_DESCRIPTION.max,
    withParams(ITEMS_DESCRIPTION),
  )
  itemsDescription: string;

  @ApiProperty({
    enum: ['in', 'out'],
    description:
      'Moving in or out (ADR 0063): the permit serves the unit’s move planned that way, if any.',
  })
  @IsIn(['in', 'out'], withParams({ allowed: ['in', 'out'] }))
  direction: 'in' | 'out';
}

export class MaterialItemDto {
  @ApiProperty({
    type: String,
    minLength: ITEM_NAME.min,
    maxLength: ITEM_NAME.max,
    example: 'Old tiles',
  })
  @Transform(trim)
  @IsString()
  @Length(ITEM_NAME.min, ITEM_NAME.max, withParams(ITEM_NAME))
  name: string;

  @ApiProperty({
    type: Number,
    minimum: ITEM_QUANTITY.min,
    maximum: ITEM_QUANTITY.max,
    example: 20,
  })
  @IsInt(withParams(ITEM_QUANTITY))
  @Min(ITEM_QUANTITY.min, withParams(ITEM_QUANTITY))
  @Max(ITEM_QUANTITY.max, withParams(ITEM_QUANTITY))
  quantity: number;
}

export class CreateMaterialExitDto {
  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    example: '2026-11-05',
    description:
      'The first local day it may be used: from today, at most 90 days ahead (DAY_OUT_OF_RANGE).',
  })
  @IsString()
  @Matches(LOCAL_DATE)
  validFrom: string;

  @ApiProperty({
    type: String,
    pattern: LOCAL_DATE.source,
    example: '2026-11-07',
    description:
      'The last local day: not before `validFrom` (ENDS_BEFORE_START), seven days at most (PERIOD_TOO_LONG).',
  })
  @IsString()
  @Matches(LOCAL_DATE)
  validUntil: string;

  @ApiProperty({
    type: [MaterialItemDto],
    description: `What goes out: 1 to ${MAX_ITEMS} lines.`,
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: MAX_ITEMS }))
  @ArrayMaxSize(MAX_ITEMS, withParams({ min: 1, max: MAX_ITEMS }))
  @ValidateNested({ each: true })
  @Type(() => MaterialItemDto)
  items: MaterialItemDto[];

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'A finalized `permit_photo` of the caller: the goods (FILE_NOT_AVAILABLE).',
  })
  @IsOptional()
  @IsUUID()
  photoFileId?: string;
}

export class PermitGuestDto {
  @ApiProperty({
    type: String,
    minLength: PERSON_NAME.min,
    maxLength: PERSON_NAME.max,
    example: 'Sara Mostafa',
    description: 'The guard checks it at the gate.',
  })
  @Transform(trim)
  @IsString()
  @Length(PERSON_NAME.min, PERSON_NAME.max, withParams(PERSON_NAME))
  fullName: string;

  @ApiProperty({
    type: String,
    required: false,
    maxLength: PLATE_MAX,
    description: `Their car’s plate, when they drive in. ${PLATE_TEXT}`,
  })
  @IsOptional()
  @IsString()
  vehiclePlate?: string;
}

export class CreateEventPermitDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'Not more than 5 minutes ago (INVALID_VALUE); its local day at most 90 days ahead (DAY_OUT_OF_RANGE).',
  })
  @ToInstant()
  @IsDate()
  startsAt: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'After `startsAt` (ENDS_BEFORE_START), 24 hours at most (WINDOW_TOO_LONG, params.maxHours); past midnight is fine.',
  })
  @ToInstant()
  @IsDate()
  endsAt: Date;

  @ApiProperty({
    type: String,
    required: false,
    minLength: EVENT_TITLE.min,
    maxLength: EVENT_TITLE.max,
    example: 'Omar’s birthday',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(EVENT_TITLE.min, EVENT_TITLE.max, withParams(EVENT_TITLE))
  title?: string;

  @ApiProperty({
    type: [PermitGuestDto],
    description: `1 to ${PERMIT_LIMITS.eventGuestsMax} guests. Up to ${PERMIT_LIMITS.eventGuestsWithoutApproval} it is approved at once and may hold ${PERMIT_LIMITS.eventGuestsWithoutApproval}; more waits for the management and may hold as many as were listed.`,
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: PERMIT_LIMITS.eventGuestsMax }))
  @ArrayMaxSize(
    PERMIT_LIMITS.eventGuestsMax,
    withParams({ min: 1, max: PERMIT_LIMITS.eventGuestsMax }),
  )
  @ValidateNested({ each: true })
  @Type(() => PermitGuestDto)
  guests: PermitGuestDto[];
}

export class AddPermitGuestsDto {
  @ApiProperty({
    type: [PermitGuestDto],
    description:
      'Until the event starts (PERMIT_STARTED); never past its guest limit (PERMIT_LIMIT_REACHED, params.scope `guests`).',
  })
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1, max: PERMIT_LIMITS.eventGuestsMax }))
  @ArrayMaxSize(
    PERMIT_LIMITS.eventGuestsMax,
    withParams({ min: 1, max: PERMIT_LIMITS.eventGuestsMax }),
  )
  @ValidateNested({ each: true })
  @Type(() => PermitGuestDto)
  guests: PermitGuestDto[];
}

export class StaffPermitsQueryDto extends UnitPermitsQueryDto {
  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({
    type: Boolean,
    required: false,
    description: 'Only approved permits in force now.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  live?: boolean;
}

export const STAFF_NOTE = { min: 1, max: 500 } as const;

export class ApprovePermitDto {
  @ApiProperty({
    type: String,
    required: false,
    maxLength: STAFF_NOTE.max,
    description: 'The management’s own note. Never shown to the unit.',
  })
  @IsOptional()
  @IsString()
  @Length(STAFF_NOTE.min, STAFF_NOTE.max, withParams(STAFF_NOTE))
  note?: string;
}

export class RejectPermitDto extends ApprovePermitDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `unitPermitReject`.',
  })
  @IsString()
  reasonCode: string;
}

export class RevokePermitDto extends ApprovePermitDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `unitPermitRevoke`.',
  })
  @IsString()
  reasonCode: string;
}

export class StopWorkDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `permitWorkStop`.',
  })
  @IsString()
  reasonCode: string;
}

export class StaffRemoveWorkerDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `permitWorkerRemove`.',
  })
  @IsString()
  reasonCode: string;
}

export const MATERIAL_DESCRIPTION = { min: 1, max: 280 } as const;

export class LogMaterialEntryDto {
  @ApiProperty({ type: String, example: 'B-12' })
  @IsString()
  @Length(1, 32, withParams({ min: 1, max: 32 }))
  unitCode: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'The unit’s works permit the materials are for, if any.',
  })
  @IsOptional()
  @IsUUID()
  permitId?: string;

  @ApiProperty({
    type: String,
    minLength: MATERIAL_DESCRIPTION.min,
    maxLength: MATERIAL_DESCRIPTION.max,
    example: '20 bags of cement, 4 boxes of tiles',
  })
  @Transform(trim)
  @IsString()
  @Length(
    MATERIAL_DESCRIPTION.min,
    MATERIAL_DESCRIPTION.max,
    withParams(MATERIAL_DESCRIPTION),
  )
  description: string;
}

export class MaterialEntriesQueryDto extends PageQueryDto {
  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({ type: String, format: 'date-time', required: false })
  @IsOptional()
  @ToInstant()
  @IsDate()
  from?: Date;

  @ApiProperty({ type: String, format: 'date-time', required: false })
  @IsOptional()
  @ToInstant()
  @IsDate()
  to?: Date;
}
