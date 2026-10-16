import { ApiProperty } from '@nestjs/swagger';
import { BoardRole } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../../../core/common/http/list';
import { withParams } from '../../../core/common/validation/validation-errors';
import { BOARD_SEATS } from '../board-rules';

export class BoardSeatDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description:
      'An active account that owns a unit now (OWNER_NOT_ELIGIBLE): from `GET /staff/governance/owners`.',
  })
  @IsUUID()
  accountId: string;

  @ApiProperty({
    enum: BoardRole,
    enumName: 'BoardRole',
    description: 'One chair, one secretary and one treasurer at most.',
  })
  @IsEnum(BoardRole)
  role: BoardRole;
}

export class AppointBoardDto {
  @ApiProperty({
    type: Number,
    minimum: BOARD_SEATS.min,
    maximum: BOARD_SEATS.max,
    description: 'The board’s seats; empty ones may be filled later.',
  })
  @IsInt(withParams(BOARD_SEATS))
  @Min(BOARD_SEATS.min, withParams(BOARD_SEATS))
  @Max(BOARD_SEATS.max, withParams(BOARD_SEATS))
  seats: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'When the term ends: 30 days to five years from now (INVALID_VALUE, params.minDays and params.maxDays).',
  })
  @Type(() => Date)
  @IsDate()
  endsAt: Date;

  @ApiProperty({
    type: [BoardSeatDto],
    description: `${BOARD_SEATS.min} members at least, as many as \`seats\` at most, each once (BOARD_SIZE, DUPLICATE_VALUE).`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BOARD_SEATS.max, withParams({ max: BOARD_SEATS.max }))
  @ValidateNested({ each: true })
  @Type(() => BoardSeatDto)
  members: BoardSeatDto[];
}

export class ChangeBoardRoleDto {
  @ApiProperty({ enum: BoardRole, enumName: 'BoardRole' })
  @IsEnum(BoardRole)
  role: BoardRole;
}

export class EndBoardSeatDto {
  @ApiProperty({
    type: String,
    description: 'From the closed list `boardMemberEnd`.',
  })
  @IsString()
  reasonCode: string;
}

export class BoardTermsQueryDto extends PageQueryDto {}

export class OwnersQueryDto {
  @ApiProperty({
    required: false,
    type: String,
    description: 'Part of a name or a unit code, any case.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 80, withParams({ min: 1, max: 80 }))
  search?: string;
}
