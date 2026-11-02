import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { LARGE_AMOUNT } from '../../core/common/amounts';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { withParams } from '../../core/common/validation/validation-errors';
import {
  CapitalPlansService,
  type CapitalPlanLineRead,
  type CapitalPlanRecord,
} from './capital-plans.service';

export class CreateCapitalPlanDto {
  @ApiProperty({
    type: Number,
    minimum: 2000,
    maximum: 2100,
    description: 'This year or one of the next five, by the compound’s day.',
  })
  @IsInt()
  @Min(2000, withParams({ min: 2000 }))
  @Max(2100, withParams({ max: 2100 }))
  year: number;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Start from the register’s replacements due that year (ADR 0065).',
  })
  @IsOptional()
  @IsBoolean()
  seed?: boolean;
}

export class CapitalPlanLineDto {
  @ApiPropertyOptional({ type: String, format: 'uuid' })
  @IsOptional()
  @IsUUID()
  assetId?: string;

  @ApiProperty({ type: String, minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200, withParams({ min: 1, max: 200 }))
  description: string;

  @ApiProperty({
    type: String,
    pattern: LARGE_AMOUNT.source,
    description: 'EGP.',
  })
  @IsString()
  @Matches(LARGE_AMOUNT)
  amount: string;
}

export class CapitalPlanLineView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  assetId: string | null;
  @ApiProperty({ type: String, nullable: true })
  assetCode: string | null;
  @ApiProperty({ type: String, nullable: true })
  assetTypeKey: string | null;
  @ApiProperty({ type: String })
  description: string;
  @ApiProperty({ type: String })
  amount: string;
  @ApiProperty({ enum: ['computed', 'manual'] })
  source: string;

  static from(l: CapitalPlanLineRead): CapitalPlanLineView {
    return { ...l };
  }
}

export class CapitalPlanView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: Number })
  year: number;
  @ApiProperty({ enum: ['draft', 'submitted', 'approved'] })
  status: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  approvalRequestId: string | null;
  @ApiProperty({ type: String, description: 'EGP, its lines together.' })
  total: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  submittedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  approvedAt: Date | null;
  @ApiProperty({ type: [CapitalPlanLineView] })
  lines: CapitalPlanLineView[];

  static from(r: CapitalPlanRecord): CapitalPlanView {
    return {
      id: r.plan.id,
      year: r.plan.year,
      status: r.plan.status,
      approvalRequestId: r.plan.approvalRequestId,
      total: r.total,
      submittedAt: r.plan.submittedAt,
      approvedAt: r.plan.approvedAt,
      lines: r.lines.map(CapitalPlanLineView.from),
    };
  }
}

/**
 * A year's capital plan for the board (ADR 0086): drawn and kept by
 * `assets.manage`; put to the board through the approvals (ADR 0055,
 * type `capital_plan`), and locked once approved.
 */
@ApiArea('maintenance')
@RequirePermissions('assets.manage')
@Controller('maintenance/capital-plans')
export class CapitalPlansController {
  constructor(private readonly plans: CapitalPlansService) {}

  @Get()
  @ApiOperation({ summary: 'The compound’s capital plans, latest year first' })
  @ApiOkResponse({ type: ListOf(CapitalPlanView) })
  async list(): Promise<ListResponse<CapitalPlanView>> {
    return bounded(await this.plans.list(), CapitalPlanView.from);
  }

  @Post()
  @ApiOperation({ summary: 'Draw a year’s capital plan (one a year)' })
  @ApiCreatedResponse({ type: CapitalPlanView })
  async create(@Body() dto: CreateCapitalPlanDto): Promise<CapitalPlanView> {
    return CapitalPlanView.from(await this.plans.create(dto));
  }

  @Get(':id')
  @ApiOperation({ summary: 'A capital plan and its lines' })
  @ApiOkResponse({ type: CapitalPlanView })
  async get(@Param('id', parseId()) id: string): Promise<CapitalPlanView> {
    return CapitalPlanView.from(await this.plans.get(id));
  }

  @Post(':id/lines')
  @ApiOperation({ summary: 'Add a line to a draft plan' })
  @ApiCreatedResponse({ type: CapitalPlanView })
  async addLine(
    @Param('id', parseId()) id: string,
    @Body() dto: CapitalPlanLineDto,
  ): Promise<CapitalPlanView> {
    return CapitalPlanView.from(await this.plans.addLine(id, dto));
  }

  @Delete(':id/lines/:lineId')
  @ApiOperation({ summary: 'Remove a line from a draft plan' })
  @ApiOkResponse({ type: CapitalPlanView })
  async removeLine(
    @Param('id', parseId()) id: string,
    @Param('lineId', parseId('lineId')) lineId: string,
  ): Promise<CapitalPlanView> {
    return CapitalPlanView.from(await this.plans.removeLine(id, lineId));
  }
}
