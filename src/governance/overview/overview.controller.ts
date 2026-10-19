import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { BoardOverviewService, type BoardOverview } from './overview.service';

const LOCAL_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export class BoardOverviewQueryDto {
  @ApiProperty({
    type: String,
    required: false,
    pattern: LOCAL_DATE.source,
    description: 'First local day; by default 29 days before `to`.',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  from?: string;

  @ApiProperty({
    type: String,
    required: false,
    pattern: LOCAL_DATE.source,
    description: 'Last local day, today by default; 31 days at most.',
  })
  @IsOptional()
  @IsString()
  @Matches(LOCAL_DATE)
  to?: string;
}

export class BoardOverviewView {
  @ApiProperty({ type: String, example: '2027-02-12' })
  from: string;
  @ApiProperty({ type: String, example: '2027-03-13' })
  to: string;
  @ApiProperty({
    type: Object,
    description:
      'By section, from the existing reports: `finance` (aging and outstanding totals today, collections over the period, the active budget’s totals) and `security` (the incidents and violations reports’ totals over the period). Totals only.',
  })
  sections: Record<string, Record<string, unknown>>;
}

/** The board's overview (ADR 0055): a sitting member only. */
@ApiArea('governance')
@RequirePermissions('governance.board')
@Controller('board/overview')
export class BoardOverviewController {
  constructor(private readonly overview: BoardOverviewService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'The board’s overview',
    description:
      'Read-only: the compound’s money, incidents and violations over a period of up to 31 days, from the existing reports.',
  })
  @ApiOkResponse({ type: BoardOverviewView })
  get(@Query() q: BoardOverviewQueryDto): Promise<BoardOverview> {
    return this.overview.overview(q);
  }
}
