import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsUUID, ValidateNested } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ReasonCodeOnlyDto } from '../../core/common/http/reason.dto';
import { ApiArea } from '../../core/common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { withParams } from '../../core/common/validation/validation-errors';
import { CreatePlanDto } from '../plans/dto/plans.dto';
import {
  PlanSuggestionsService,
  SUGGESTION_STATUSES,
  type SuggestionStatus,
} from './plan-suggestions.service';
import { PlanSuggestionView } from './analytics.views';

export class PlanSuggestionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: SUGGESTION_STATUSES,
    enumName: 'PlanSuggestionStatus',
  })
  @IsOptional()
  @IsIn(SUGGESTION_STATUSES, withParams({ allowed: [...SUGGESTION_STATUSES] }))
  status?: SuggestionStatus;
}

export class AcceptPlanSuggestionDto {
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description:
      'An active plan that covers it already (of the suggestion’s asset, when it names one); nothing of the plan changes.',
  })
  @IsOptional()
  @IsUUID()
  planId?: string;

  @ApiPropertyOptional({
    type: CreatePlanDto,
    description:
      'A new plan, by the plans’ own rules (an asset not in a unit; the suggestion’s own when it names one); its category is the suggestion’s by default.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreatePlanDto)
  plan?: CreatePlanDto;
}

/**
 * Plan suggestions (ADR 0081): repeat faults that ask for planned work,
 * read with `assets.read` and decided once with `assets.manage`.
 */
@ApiArea('maintenance')
@RequirePermissions('assets.manage')
@Controller('maintenance/plan-suggestions')
export class PlanSuggestionsController {
  constructor(private readonly suggestions: PlanSuggestionsService) {}

  @Get()
  @RequirePermissions('assets.read')
  @ApiOperation({ summary: 'List the plan suggestions' })
  @ApiOkResponse({ type: ListOf(PlanSuggestionView) })
  async list(
    @Query() q: PlanSuggestionsQueryDto,
  ): Promise<ListResponse<PlanSuggestionView>> {
    return toList(await this.suggestions.list(q), (r) =>
      PlanSuggestionView.from(r),
    );
  }

  @Get(':id')
  @RequirePermissions('assets.read')
  @ApiOperation({ summary: 'Get a plan suggestion' })
  @ApiOkResponse({ type: PlanSuggestionView })
  async get(@Param('id', parseId()) id: string): Promise<PlanSuggestionView> {
    return PlanSuggestionView.from(await this.suggestions.get(id));
  }

  /** Into a new plan (`plan`) or one that covers it already (`planId`). */
  @Post(':id/accept')
  @ApiOperation({ summary: 'Accept a plan suggestion into a plan' })
  @ApiOkResponse({ type: PlanSuggestionView })
  async accept(
    @Param('id', parseId()) id: string,
    @Body() dto: AcceptPlanSuggestionDto,
  ): Promise<PlanSuggestionView> {
    return PlanSuggestionView.from(await this.suggestions.accept(id, dto));
  }

  /** `reasonCode` from `planSuggestionDismiss`. */
  @Post(':id/dismiss')
  @ApiOperation({ summary: 'Dismiss a plan suggestion' })
  @ApiOkResponse({ type: PlanSuggestionView })
  async dismiss(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<PlanSuggestionView> {
    return PlanSuggestionView.from(
      await this.suggestions.dismiss(id, dto.reasonCode),
    );
  }
}
