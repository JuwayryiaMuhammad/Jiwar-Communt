import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { REASON_CODES } from '../../../core/common/reasons';
import { LOCAL_DATE } from '../../schedules/local-dates';
import {
  ASSET_CODE,
  ASSET_CONDITIONS,
  ASSET_CRITICALITIES,
  ASSET_NAME,
  ASSET_STATUSES,
  ASSET_TEXT,
  LIFE_YEARS,
  MAX_SERVED_BUILDINGS,
  MONEY,
  VENDOR_PHONE,
  type AssetCondition,
  type AssetCriticality,
  type AssetStatus,
} from '../asset-rules';

const allowed = (xs: readonly string[]) => withParams({ allowed: [...xs] });
const BUILDING = { min: 1, max: 80 };

/** The card's facts; on an update each may be null to clear it. */
class AssetFactsDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 120,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(ASSET_TEXT.min, ASSET_TEXT.max, withParams(ASSET_TEXT))
  manufacturer?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 120,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(ASSET_TEXT.min, ASSET_TEXT.max, withParams(ASSET_TEXT))
  model?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 120,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(ASSET_TEXT.min, ASSET_TEXT.max, withParams(ASSET_TEXT))
  serialNumber?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    nullable: true,
    description: 'The compound’s day it went into service, `YYYY-MM-DD`.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(LOCAL_DATE)
  commissionedOn?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: MONEY.source,
    description: 'EGP.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(MONEY)
  purchaseValue?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: MONEY.source,
    description: 'EGP: what a new one would cost.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(MONEY)
  replacementCost?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: MONEY.source,
    description: 'EGP a day it is down.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(MONEY)
  downtimeCostPerDay?: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: LIFE_YEARS.min,
    maximum: LIFE_YEARS.max,
    description: 'Overrides its type’s.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt(withParams(LIFE_YEARS))
  @Min(LIFE_YEARS.min, withParams(LIFE_YEARS))
  @Max(LIFE_YEARS.max, withParams(LIFE_YEARS))
  expectedLifeYears?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    minLength: 1,
    maxLength: 120,
    description: 'A business, plain data.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(ASSET_TEXT.min, ASSET_TEXT.max, withParams(ASSET_TEXT))
  vendorName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: VENDOR_PHONE.source,
    description: 'The vendor’s business line.',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(VENDOR_PHONE)
  vendorPhone?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(LOCAL_DATE)
  warrantyEndsOn?: string | null;

  @ApiPropertyOptional({ enum: ASSET_CRITICALITIES, default: 'medium' })
  @IsOptional()
  @IsIn(ASSET_CRITICALITIES, allowed(ASSET_CRITICALITIES))
  criticality?: AssetCriticality;

  @ApiPropertyOptional({ enum: ASSET_CONDITIONS, default: 'good' })
  @IsOptional()
  @IsIn(ASSET_CONDITIONS, allowed(ASSET_CONDITIONS))
  condition?: AssetCondition;

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_SERVED_BUILDINGS,
    description:
      'The buildings it serves (a pump, a generator), as the units have them.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SERVED_BUILDINGS, withParams({ max: MAX_SERVED_BUILDINGS }))
  @IsString({ each: true })
  @Length(BUILDING.min, BUILDING.max, { each: true, ...withParams(BUILDING) })
  servesBuildings?: string[];
}

export class CreateAssetDto extends AssetFactsDto {
  @ApiProperty({
    type: String,
    pattern: ASSET_CODE.source,
    description: 'Unique; never changes.',
  })
  @IsString()
  @Matches(ASSET_CODE)
  code: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An active asset type.',
  })
  @IsUUID()
  typeId: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'The asset it is part of: it goes where its parent is (no `unitId` or `commonAreaId`).',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'A root in a unit.',
  })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'A root in an active common area.',
  })
  @IsOptional()
  @IsUUID()
  commonAreaId?: string;

  @ApiProperty({
    type: String,
    minLength: ASSET_NAME.min,
    maxLength: ASSET_NAME.max,
  })
  @IsString()
  @Length(ASSET_NAME.min, ASSET_NAME.max, withParams(ASSET_NAME))
  nameAr: string;

  @ApiProperty({
    type: String,
    minLength: ASSET_NAME.min,
    maxLength: ASSET_NAME.max,
  })
  @IsString()
  @Length(ASSET_NAME.min, ASSET_NAME.max, withParams(ASSET_NAME))
  nameEn: string;
}

export class UpdateAssetDto extends AssetFactsDto {
  @ApiPropertyOptional({
    type: String,
    minLength: ASSET_NAME.min,
    maxLength: ASSET_NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(ASSET_NAME.min, ASSET_NAME.max, withParams(ASSET_NAME))
  nameAr?: string;

  @ApiPropertyOptional({
    type: String,
    minLength: ASSET_NAME.min,
    maxLength: ASSET_NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(ASSET_NAME.min, ASSET_NAME.max, withParams(ASSET_NAME))
  nameEn?: string;
}

const SETTABLE = ['in_service', 'out_of_service'] as const;

export class AssetStatusDto {
  @ApiProperty({ enum: SETTABLE })
  @IsIn(SETTABLE, allowed(SETTABLE))
  status: (typeof SETTABLE)[number];

  @ApiPropertyOptional({
    enum: REASON_CODES.assetOutOfService,
    description: 'Required out of service; not allowed back in service.',
  })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class RetireAssetDto {
  @ApiProperty({ enum: REASON_CODES.assetRetire })
  @IsOptional()
  @IsString()
  reasonCode?: string;
}

export class MoveAssetDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  commonAreaId?: string;
}

export class AssetsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  typeId?: string;

  @ApiPropertyOptional({ enum: ASSET_STATUSES })
  @IsOptional()
  @IsIn(ASSET_STATUSES, allowed(ASSET_STATUSES))
  status?: AssetStatus;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  commonAreaId?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Its direct parts.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({ enum: ASSET_CRITICALITIES })
  @IsOptional()
  @IsIn(ASSET_CRITICALITIES, allowed(ASSET_CRITICALITIES))
  criticality?: AssetCriticality;
}
