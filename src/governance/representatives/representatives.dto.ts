import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { PageQueryDto } from '../../core/common/http/list';
import { withParams } from '../../core/common/validation/validation-errors';
import {
  REPRESENTATIVE_MATTER_ACTIONS,
  REPRESENTATIVE_MATTER_STATUSES,
  REPRESENTATIVE_MESSAGE_MAX,
  type RepresentativeMatterAction,
  type RepresentativeMatterStatus,
} from './representative-rules';

export class RaiseRepresentativeMatterDto {
  @ApiProperty({
    enum: REPRESENTATIVE_MATTER_ACTIONS,
    enumName: 'RepresentativeMatterAction',
    description:
      '`appoint` names `accountId` the representative of `building` (replacing the sitting one); `end` ends the term `representativeId`.',
  })
  @IsIn(
    REPRESENTATIVE_MATTER_ACTIONS,
    withParams({ allowed: [...REPRESENTATIVE_MATTER_ACTIONS] }),
  )
  action: RepresentativeMatterAction;

  @ApiProperty({
    type: String,
    required: false,
    minLength: 1,
    maxLength: 100,
    description:
      'To appoint: the building, as the compound names it on its units.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 100, withParams({ min: 1, max: 100 }))
  building?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'To appoint: an owner of a unit in the building (REPRESENTATIVE_NOT_AN_OWNER), from `GET /board/representatives/candidates`.',
  })
  @IsOptional()
  @IsUUID()
  accountId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'To end: the sitting term.',
  })
  @IsOptional()
  @IsUUID()
  representativeId?: string;
}

export class RepresentativeMattersQueryDto extends PageQueryDto {
  @ApiProperty({
    enum: REPRESENTATIVE_MATTER_STATUSES,
    enumName: 'RepresentativeMatterStatus',
    required: false,
  })
  @IsOptional()
  @IsIn(
    REPRESENTATIVE_MATTER_STATUSES,
    withParams({ allowed: [...REPRESENTATIVE_MATTER_STATUSES] }),
  )
  status?: RepresentativeMatterStatus;
}

export class RepresentativeCandidatesQueryDto {
  @ApiProperty({ type: String, minLength: 1, maxLength: 100 })
  @IsString()
  @Length(1, 100, withParams({ min: 1, max: 100 }))
  building: string;
}

export class RepresentativeMessageDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: REPRESENTATIVE_MESSAGE_MAX,
  })
  @IsString()
  @Length(
    1,
    REPRESENTATIVE_MESSAGE_MAX,
    withParams({ min: 1, max: REPRESENTATIVE_MESSAGE_MAX }),
  )
  body: string;
}
