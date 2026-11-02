import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { RequirePermissions } from '../access/require-permissions.decorator';
import { ApiArea, NoStore } from '../common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../common/http/list';
import { parseId } from '../common/validation/parse-id.pipe';
import { withParams } from '../common/validation/validation-errors';
import {
  CORRESPONDENCE_TYPES,
  type CorrespondenceRow,
  type CorrespondenceType,
  type Direction,
} from './unit-correspondence';
import { UnitCorrespondenceService } from './unit-correspondence.service';

export class CorrespondenceQueryDto extends PageQueryDto {
  @ApiProperty({ enum: CORRESPONDENCE_TYPES, required: false })
  @IsOptional()
  @IsIn(
    CORRESPONDENCE_TYPES,
    withParams({ allowed: [...CORRESPONDENCE_TYPES] }),
  )
  type?: CorrespondenceType;
}

/** One row of a unit's timeline: codes and references, never a word. */
export class CorrespondenceView {
  @ApiProperty({ enum: CORRESPONDENCE_TYPES })
  type: CorrespondenceType;
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true, example: 'MR-000123' })
  number: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'What it is within its type: a topic’s or category’s key, a letter’s kind.',
  })
  kind: string | null;
  @ApiProperty({ type: String, nullable: true })
  status: string | null;
  @ApiProperty({
    enum: ['from_unit', 'to_unit'],
    description: 'Who wrote first: the unit’s people, or to them.',
  })
  direction: Direction;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;

  static from(r: CorrespondenceRow): CorrespondenceView {
    return { ...r };
  }
}

/** A unit's correspondence (ADR 0080): each read is logged. */
@ApiArea('units')
@RequirePermissions('correspondence.read')
@Controller('staff/units')
export class UnitCorrespondenceController {
  constructor(private readonly correspondence: UnitCorrespondenceService) {}

  @Get(':unitId/correspondence')
  @NoStore()
  @ApiOperation({ summary: 'Read a unit’s correspondence, newest first' })
  @ApiOkResponse({ type: ListOf(CorrespondenceView) })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Query() q: CorrespondenceQueryDto,
  ): Promise<ListResponse<CorrespondenceView>> {
    return toList(await this.correspondence.list(unitId, q), (r) =>
      CorrespondenceView.from(r),
    );
  }
}
