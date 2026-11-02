import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { IsLocalDate, LOCAL_DATE } from '../../schedules/local-dates';
import {
  DOCUMENT_NUMBER,
  REGISTRY_NUMBER,
  VENDOR_CATEGORIES,
  VENDOR_DOCUMENT_KINDS,
  VENDOR_LIMITS,
  VENDOR_PHONE,
  VENDOR_STATUSES,
  type VendorCategory,
  type VendorDocumentKind,
  type VendorStatus,
} from '../vendor-rules';

const allowed = (xs: readonly string[]) => withParams({ allowed: [...xs] });
const len = (max: number) => withParams({ min: 1, max });

export class CreateVendorDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: VENDOR_LIMITS.name,
    description: 'Unique in the compound, whatever its case.',
  })
  @IsString()
  @Length(1, VENDOR_LIMITS.name, len(VENDOR_LIMITS.name))
  name: string;

  @ApiPropertyOptional({ type: String, maxLength: VENDOR_LIMITS.legalName })
  @IsOptional()
  @IsString()
  @Length(1, VENDOR_LIMITS.legalName, len(VENDOR_LIMITS.legalName))
  legalName?: string;

  @ApiPropertyOptional({ type: String, pattern: REGISTRY_NUMBER.source })
  @IsOptional()
  @IsString()
  @Matches(REGISTRY_NUMBER)
  commercialRegister?: string;

  @ApiPropertyOptional({ type: String, pattern: REGISTRY_NUMBER.source })
  @IsOptional()
  @IsString()
  @Matches(REGISTRY_NUMBER)
  taxNumber?: string;

  @ApiPropertyOptional({
    enum: VENDOR_CATEGORIES,
    enumName: 'VendorCategory',
    isArray: true,
    minItems: 1,
    maxItems: VENDOR_CATEGORIES.length,
    description: 'Its trades; `other` when none is given.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1 }))
  @ArrayMaxSize(
    VENDOR_CATEGORIES.length,
    withParams({ max: VENDOR_CATEGORIES.length }),
  )
  @IsIn(VENDOR_CATEGORIES, { each: true, ...allowed(VENDOR_CATEGORIES) })
  categories?: VendorCategory[];

  @ApiPropertyOptional({ type: String, maxLength: VENDOR_LIMITS.contactName })
  @IsOptional()
  @IsString()
  @Length(1, VENDOR_LIMITS.contactName, len(VENDOR_LIMITS.contactName))
  contactName?: string;

  @ApiPropertyOptional({ type: String, pattern: VENDOR_PHONE.source })
  @IsOptional()
  @IsString()
  @Matches(VENDOR_PHONE)
  phone?: string;

  @ApiPropertyOptional({ type: String, format: 'email', maxLength: 254 })
  @IsOptional()
  @IsString()
  @MaxLength(254, withParams({ max: 254 }))
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ type: String, maxLength: VENDOR_LIMITS.address })
  @IsOptional()
  @IsString()
  @Length(1, VENDOR_LIMITS.address, len(VENDOR_LIMITS.address))
  address?: string;

  @ApiPropertyOptional({ type: String, maxLength: VENDOR_LIMITS.notes })
  @IsOptional()
  @IsString()
  @Length(1, VENDOR_LIMITS.notes, len(VENDOR_LIMITS.notes))
  notes?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'The same company as this partner (ADR 0060); at most one vendor a partner.',
  })
  @IsOptional()
  @IsUUID()
  partnerId?: string;
}

/** Every field optional; null clears an optional one. */
export class UpdateVendorDto {
  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: VENDOR_LIMITS.name,
  })
  @IsOptional()
  @IsString()
  @Length(1, VENDOR_LIMITS.name, len(VENDOR_LIMITS.name))
  name?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: VENDOR_LIMITS.legalName,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, VENDOR_LIMITS.legalName, len(VENDOR_LIMITS.legalName))
  legalName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: REGISTRY_NUMBER.source,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(REGISTRY_NUMBER)
  commercialRegister?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: REGISTRY_NUMBER.source,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(REGISTRY_NUMBER)
  taxNumber?: string | null;

  @ApiPropertyOptional({
    enum: VENDOR_CATEGORIES,
    enumName: 'VendorCategory',
    isArray: true,
    minItems: 1,
    maxItems: VENDOR_CATEGORIES.length,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, withParams({ min: 1 }))
  @ArrayMaxSize(
    VENDOR_CATEGORIES.length,
    withParams({ max: VENDOR_CATEGORIES.length }),
  )
  @IsIn(VENDOR_CATEGORIES, { each: true, ...allowed(VENDOR_CATEGORIES) })
  categories?: VendorCategory[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: VENDOR_LIMITS.contactName,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, VENDOR_LIMITS.contactName, len(VENDOR_LIMITS.contactName))
  contactName?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: VENDOR_PHONE.source,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Matches(VENDOR_PHONE)
  phone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'email',
    maxLength: 254,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(254, withParams({ max: 254 }))
  @IsEmail()
  email?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: VENDOR_LIMITS.address,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, VENDOR_LIMITS.address, len(VENDOR_LIMITS.address))
  address?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: VENDOR_LIMITS.notes,
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @Length(1, VENDOR_LIMITS.notes, len(VENDOR_LIMITS.notes))
  notes?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, format: 'uuid' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  partnerId?: string | null;
}

export class AddVendorDocumentDto {
  @ApiProperty({ enum: VENDOR_DOCUMENT_KINDS, enumName: 'VendorDocumentKind' })
  @IsIn(VENDOR_DOCUMENT_KINDS, allowed(VENDOR_DOCUMENT_KINDS))
  kind: VendorDocumentKind;

  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'An uploaded file of purpose `vendor_document`, finalized.',
  })
  @IsUUID()
  fileId: string;

  @ApiPropertyOptional({ type: String, pattern: DOCUMENT_NUMBER.source })
  @IsOptional()
  @IsString()
  @Matches(DOCUMENT_NUMBER)
  number?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  issuedOn?: string;

  @ApiPropertyOptional({
    type: String,
    format: 'date',
    pattern: LOCAL_DATE.source,
    description:
      'Its last day in force; after `issuedOn`. Announced 30 days ahead.',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  expiresOn?: string;
}

const SCORE = { min: 1, max: 5 };
const score = () =>
  ({ type: Number, minimum: SCORE.min, maximum: SCORE.max }) as const;

export class EvaluateVendorDto {
  @ApiProperty(score())
  @IsInt()
  @Min(1, withParams(SCORE))
  @Max(5, withParams(SCORE))
  quality: number;

  @ApiProperty(score())
  @IsInt()
  @Min(1, withParams(SCORE))
  @Max(5, withParams(SCORE))
  timeliness: number;

  @ApiProperty(score())
  @IsInt()
  @Min(1, withParams(SCORE))
  @Max(5, withParams(SCORE))
  cost: number;

  @ApiProperty(score())
  @IsInt()
  @Min(1, withParams(SCORE))
  @Max(5, withParams(SCORE))
  communication: number;

  @ApiProperty(score())
  @IsInt()
  @Min(1, withParams(SCORE))
  @Max(5, withParams(SCORE))
  safety: number;

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'One of its contracts, when the evaluation is of that.',
  })
  @IsOptional()
  @IsUUID()
  contractId?: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: VENDOR_LIMITS.evaluationNote,
  })
  @IsOptional()
  @IsString()
  @Length(1, VENDOR_LIMITS.evaluationNote, len(VENDOR_LIMITS.evaluationNote))
  note?: string;
}

export class VendorsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: VENDOR_STATUSES, enumName: 'VendorStatus' })
  @IsOptional()
  @IsIn(VENDOR_STATUSES, allowed(VENDOR_STATUSES))
  status?: VendorStatus;

  @ApiPropertyOptional({ enum: VENDOR_CATEGORIES, enumName: 'VendorCategory' })
  @IsOptional()
  @IsIn(VENDOR_CATEGORIES, allowed(VENDOR_CATEGORIES))
  category?: VendorCategory;

  @ApiPropertyOptional({
    type: String,
    minLength: 1,
    maxLength: VENDOR_LIMITS.name,
    description: 'A part of its name or legal name, whatever the case.',
  })
  @IsOptional()
  @IsString()
  @Length(1, VENDOR_LIMITS.name, len(VENDOR_LIMITS.name))
  q?: string;
}
