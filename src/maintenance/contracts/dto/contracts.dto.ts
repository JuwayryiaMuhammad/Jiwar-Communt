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
import { MONEY } from '../../costs/cost-rules';
import { LOCAL_DATE } from '../../schedules/local-dates';
import { STOCK_CODE } from '../../stock/stock-rules';
import {
  CONTRACT_ASSETS_MAX,
  CONTRACT_KINDS,
  CONTRACT_NOTICE_DAYS,
  CONTRACT_SCOPE,
  CONTRACT_STATUSES,
  VENDOR_NAME,
  VENDOR_PHONE,
  type ContractKind,
  type ContractStatus,
} from '../contract-rules';

const allowed = (xs: readonly string[]) => withParams({ allowed: [...xs] });

export class CreateContractDto {
  @ApiProperty({
    type: String,
    pattern: STOCK_CODE.source,
    description: 'The compound’s reference for it, unique. Never changes.',
  })
  @IsString()
  @Matches(STOCK_CODE)
  code: string;

  @ApiProperty({ enum: CONTRACT_KINDS, enumName: 'MaintenanceContractKind' })
  @IsIn(CONTRACT_KINDS, allowed(CONTRACT_KINDS))
  kind: ContractKind;

  @ApiProperty({ type: String, minLength: 1, maxLength: VENDOR_NAME.max })
  @IsString()
  @Length(VENDOR_NAME.min, VENDOR_NAME.max, withParams(VENDOR_NAME))
  vendorName: string;

  @ApiPropertyOptional({ type: String, pattern: VENDOR_PHONE.source })
  @IsOptional()
  @IsString()
  @Matches(VENDOR_PHONE)
  vendorPhone?: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: CONTRACT_SCOPE.max,
    description: 'What it covers, in the compound’s words.',
  })
  @IsOptional()
  @IsString()
  @Length(CONTRACT_SCOPE.min, CONTRACT_SCOPE.max, withParams(CONTRACT_SCOPE))
  scope?: string;

  @ApiProperty({ type: String, format: 'date', pattern: LOCAL_DATE.source })
  @IsString()
  @Matches(LOCAL_DATE)
  startsOn: string;

  @ApiProperty({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
    description: 'Its last day; after `startsOn`.',
  })
  @IsString()
  @Matches(LOCAL_DATE)
  endsOn: string;

  @ApiPropertyOptional({
    type: String,
    pattern: MONEY.source,
    description: 'EGP a year.',
  })
  @IsOptional()
  @IsString()
  @Matches(MONEY)
  annualValue?: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: CONTRACT_NOTICE_DAYS.min,
    maximum: CONTRACT_NOTICE_DAYS.max,
    default: 30,
    description: 'How many days before its end the end is announced.',
  })
  @IsOptional()
  @IsInt()
  @Min(CONTRACT_NOTICE_DAYS.min, withParams(CONTRACT_NOTICE_DAYS))
  @Max(CONTRACT_NOTICE_DAYS.max, withParams(CONTRACT_NOTICE_DAYS))
  noticeDays?: number;
}

export class UpdateContractDto {
  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: VENDOR_NAME.max,
  })
  @IsOptional()
  @IsString()
  @Length(VENDOR_NAME.min, VENDOR_NAME.max, withParams(VENDOR_NAME))
  vendorName?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: VENDOR_PHONE.source,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(VENDOR_PHONE)
  vendorPhone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: CONTRACT_SCOPE.max,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(CONTRACT_SCOPE.min, CONTRACT_SCOPE.max, withParams(CONTRACT_SCOPE))
  scope?: string | null;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  startsOn?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  endsOn?: string;

  @ApiPropertyOptional({ type: String, nullable: true, pattern: MONEY.source })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(MONEY)
  annualValue?: string | null;

  @ApiPropertyOptional({
    type: Number,
    minimum: CONTRACT_NOTICE_DAYS.min,
    maximum: CONTRACT_NOTICE_DAYS.max,
  })
  @IsOptional()
  @IsInt()
  @Min(CONTRACT_NOTICE_DAYS.min, withParams(CONTRACT_NOTICE_DAYS))
  @Max(CONTRACT_NOTICE_DAYS.max, withParams(CONTRACT_NOTICE_DAYS))
  noticeDays?: number;
}

export class ContractAssetsDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    maxItems: CONTRACT_ASSETS_MAX,
    description: 'Every asset it covers from now on.',
  })
  @IsArray()
  @ArrayMaxSize(CONTRACT_ASSETS_MAX, withParams({ max: CONTRACT_ASSETS_MAX }))
  @IsUUID('all', { each: true })
  assetIds: string[];
}

export class ContractsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: CONTRACT_STATUSES,
    description: 'Read from its dates on the compound’s today.',
  })
  @IsOptional()
  @IsIn(CONTRACT_STATUSES, allowed(CONTRACT_STATUSES))
  status?: ContractStatus;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Covering it.',
  })
  @IsOptional()
  @IsUUID()
  assetId?: string;
}
