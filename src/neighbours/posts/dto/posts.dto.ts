import { ApiProperty } from '@nestjs/swagger';
import { NeighbourPostKind } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { ExclusiveWith } from '../../../core/common/validation/exclusive-with';
import { withParams } from '../../../core/common/validation/validation-errors';
import { IsLocalDate } from '../../../core/common/validation/local-date';
import { CLAIM_NOTE_LENGTH } from '../../claims/claims.service';
import { BOARDS, POST_STATES, type Board, type PostState } from '../post-rules';
import {
  MAX_PHOTOS,
  POST_BODY_LENGTH,
  POST_PLACE_LENGTH,
} from '../posts.service';

const BOOLEAN = ['true', 'false'] as const;

export class CreatePostDto {
  @ApiProperty({
    enum: NeighbourPostKind,
    enumName: 'NeighbourPostKind',
    description:
      '`lost` or `found` on the lost-and-found board; `lend` (can lend) or `borrow` (wants to borrow) on the lending board. The staff post only `lost` and `found`.',
  })
  @IsEnum(
    NeighbourPostKind,
    withParams({ allowed: Object.values(NeighbourPostKind) }),
  )
  kind: NeighbourPostKind;

  @ApiProperty({
    type: String,
    minLength: POST_BODY_LENGTH.min,
    maxLength: POST_BODY_LENGTH.max,
    description: 'A few words: what it is.',
  })
  @IsString()
  @Length(
    POST_BODY_LENGTH.min,
    POST_BODY_LENGTH.max,
    withParams({ ...POST_BODY_LENGTH }),
  )
  body: string;

  @ApiProperty({
    type: String,
    required: false,
    minLength: POST_PLACE_LENGTH.min,
    maxLength: POST_PLACE_LENGTH.max,
    description: 'Where it was lost or found, or where to meet.',
  })
  @IsOptional()
  @IsString()
  @Length(
    POST_PLACE_LENGTH.min,
    POST_PLACE_LENGTH.max,
    withParams({ ...POST_PLACE_LENGTH }),
  )
  place?: string;

  @ApiProperty({
    type: String,
    format: 'date',
    required: false,
    example: '2026-10-19',
    description:
      'The day it was lost or found, not in the future. Not for a lending post (FIELD_NOT_ALLOWED).',
  })
  @IsOptional()
  @IsString()
  @IsLocalDate()
  occurredOn?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'One of the author’s own units, when they have several: other residents see its building and nothing else. Not for the staff (FIELD_NOT_ALLOWED).',
  })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    required: false,
    maxItems: MAX_PHOTOS,
    description:
      'The caller’s own finalized `neighbour_post_photo` files (FILE_NOT_AVAILABLE).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_PHOTOS, withParams({ min: 0, max: MAX_PHOTOS }))
  @IsUUID(undefined, { each: true })
  photoFileIds?: string[];
}

class PostsFilterDto extends PageQueryDto {
  @ApiProperty({
    enum: BOARDS,
    required: false,
    description: '`lost_found` or `lending`.',
  })
  @IsOptional()
  @IsIn(BOARDS, withParams({ allowed: [...BOARDS] }))
  board?: Board;

  @ApiProperty({
    enum: NeighbourPostKind,
    enumName: 'NeighbourPostKind',
    required: false,
  })
  @IsOptional()
  @IsEnum(
    NeighbourPostKind,
    withParams({ allowed: Object.values(NeighbourPostKind) }),
  )
  kind?: NeighbourPostKind;
}

export class BoardQueryDto extends PostsFilterDto {
  @ApiProperty({
    enum: BOOLEAN,
    required: false,
    description:
      '`true`: my own posts, whatever their state, instead of the board.',
  })
  @IsOptional()
  @IsIn(BOOLEAN, withParams({ allowed: [...BOOLEAN] }))
  mine?: 'true' | 'false';
}

export class StaffPostsQueryDto extends PostsFilterDto {
  @ApiProperty({
    enum: POST_STATES,
    required: false,
    description:
      '`open`: on its board. `expired`: its day passed and nobody closed it. `closed`.',
  })
  @IsOptional()
  @IsIn(POST_STATES, withParams({ allowed: [...POST_STATES] }))
  state?: PostState;
}

/** A code from a closed list, never text. */
export class PostReasonDto {
  @ApiProperty({
    type: String,
    description:
      'A code of the action’s list: `neighbourPostClose` for the author, `neighbourPostRemove` or `neighbourClaimDecline` for the staff (INVALID_REASON_CODE names the allowed ones).',
  })
  @IsString()
  reasonCode: string;
}

export class CreateClaimDto {
  @ApiProperty({
    type: String,
    required: false,
    minLength: CLAIM_NOTE_LENGTH.min,
    maxLength: CLAIM_NOTE_LENGTH.max,
    description:
      'For the staff alone: how they will know it is yours. Never shown to whoever posted the item.',
  })
  @IsOptional()
  @IsString()
  @Length(
    CLAIM_NOTE_LENGTH.min,
    CLAIM_NOTE_LENGTH.max,
    withParams({ ...CLAIM_NOTE_LENGTH }),
  )
  note?: string;
}

/** Exactly one of the two. */
export class HandOverDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description: 'A pending claim on this item: it goes to its claimant.',
  })
  @ValidateIf(
    (o: HandOverDto) =>
      o.claimId !== undefined || o.recipientAccountId === undefined,
  )
  @IsUUID()
  claimId?: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    required: false,
    description:
      'A resident who came without a claim (RECIPIENT_NOT_ELIGIBLE). Not with `claimId`.',
  })
  @IsOptional()
  @ExclusiveWith('claimId')
  @IsUUID()
  recipientAccountId?: string;
}
