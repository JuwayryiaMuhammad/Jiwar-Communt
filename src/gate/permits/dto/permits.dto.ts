import { ApiProperty } from '@nestjs/swagger';
import { IdDocumentType, UnitPermitKind } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { REASON_CODES } from '../../../core/common/reasons';
import { withParams } from '../../../core/common/validation/validation-errors';
import { LOCAL_DATE } from '../../vehicles/dto/vehicles.dto';
import { PERMIT_VIEW_STATUSES } from '../views/permit.views';
import { PermitHoursDto } from './permit-settings.dto';

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
