import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { IsLocalDate } from '../../../core/common/validation/local-date';
import { withParams } from '../../../core/common/validation/validation-errors';
import { OFFER_BODY_LENGTH, OFFER_TITLE_LENGTH } from '../offers.service';

function Text(range: { min: number; max: number }) {
  return (target: object, key: string) => {
    ApiProperty({ type: String, minLength: range.min, maxLength: range.max })(
      target,
      key,
    );
    IsString()(target, key);
    Length(range.min, range.max, withParams({ ...range }))(target, key);
  };
}

export class PublishOfferDto {
  @Text(OFFER_TITLE_LENGTH)
  titleEn: string;

  @Text(OFFER_TITLE_LENGTH)
  titleAr: string;

  @Text(OFFER_BODY_LENGTH)
  bodyEn: string;

  @Text(OFFER_BODY_LENGTH)
  bodyAr: string;

  @ApiProperty({
    type: String,
    format: 'date',
    example: '2026-11-01',
    description: 'The compound’s day it starts.',
  })
  @IsString()
  @IsLocalDate()
  validFromOn: string;

  @ApiProperty({
    type: String,
    format: 'date',
    example: '2026-11-30',
    description:
      'Its last day: not before the start, not past, within a year (INVALID_VALUE).',
  })
  @IsString()
  @IsLocalDate()
  validToOn: string;
}

export class StaffOffersQueryDto extends PageQueryDto {
  @ApiProperty({ type: String, format: 'uuid', required: false })
  @IsOptional()
  @IsUUID('all')
  partnerId?: string;
}
