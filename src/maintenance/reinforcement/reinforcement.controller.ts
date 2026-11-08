import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  ReinforcementCallsQueryDto,
  ReinforcementReasonDto,
  ReinforcementSuggestionsQueryDto,
  SendReinforcementCallDto,
} from './dto/reinforcement.dto';
import { ReinforcementService } from './reinforcement.service';
import {
  ReinforcementCallView,
  ReinforcementSuggestionView,
} from './views/reinforcement.views';

/** Peak reinforcement, as the field team runs it (ADR 0090). */
@ApiArea('field-team')
@RequirePermissions('field_team.manage')
@Controller('staff/field-team')
export class StaffReinforcementController {
  constructor(private readonly reinforcement: ReinforcementService) {}

  @Get('reinforcement-suggestions')
  @NoStore()
  @ApiOperation({
    summary: 'List the reinforcement suggestions',
    description:
      'Made when service pressure’s rise is told; newest first. Nothing reaches a technician by itself.',
  })
  @ApiOkResponse({ type: ListOf(ReinforcementSuggestionView) })
  async suggestions(
    @Query() q: ReinforcementSuggestionsQueryDto,
  ): Promise<ListResponse<ReinforcementSuggestionView>> {
    return bounded(await this.reinforcement.suggestions(q), (r) =>
      ReinforcementSuggestionView.from(r),
    );
  }

  @Post('reinforcement-suggestions/:id/dismiss')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Dismiss a reinforcement suggestion',
    description: 'Once, with a code from `reinforcementDismiss`.',
  })
  @ApiOkResponse({ type: ReinforcementSuggestionView })
  async dismiss(
    @Param('id', parseId()) id: string,
    @Body() dto: ReinforcementReasonDto,
  ): Promise<ReinforcementSuggestionView> {
    return ReinforcementSuggestionView.from(
      await this.reinforcement.dismiss(id, dto.reasonCode),
    );
  }

  @Post('reinforcement-calls')
  @NoStore()
  @ApiOperation({
    summary: 'Call reinforcement',
    description:
      'Asks every technician off duty now to come in for a window (critical): 1 to 10 needed, from 15 minutes to 12 hours ahead, for 1 to 12 hours, in a zone or the whole compound. Accepting writes a roster slot.',
  })
  @ApiCreatedResponse({ type: ReinforcementCallView })
  async send(
    @Body() dto: SendReinforcementCallDto,
  ): Promise<ReinforcementCallView> {
    return ReinforcementCallView.from(await this.reinforcement.send(dto));
  }

  @Get('reinforcement-calls')
  @NoStore()
  @ApiOperation({
    summary: 'List the reinforcement calls',
    description: 'Newest first.',
  })
  @ApiOkResponse({ type: ListOf(ReinforcementCallView) })
  async calls(
    @Query() q: ReinforcementCallsQueryDto,
  ): Promise<ListResponse<ReinforcementCallView>> {
    return bounded(await this.reinforcement.calls(q), (r) =>
      ReinforcementCallView.from(r),
    );
  }

  @Get('reinforcement-calls/:id')
  @NoStore()
  @ApiOperation({
    summary: 'Get a reinforcement call',
    description: 'With whom it reached and their answers.',
  })
  @ApiOkResponse({ type: ReinforcementCallView })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<ReinforcementCallView> {
    return ReinforcementCallView.from(await this.reinforcement.get(id));
  }

  @Post('reinforcement-calls/:id/cancel')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Call off a reinforcement call',
    description:
      'Once, while open, with a code from `reinforcementCancel`: the accepted slots nobody filled are cancelled, and whoever it reached and did not decline is told.',
  })
  @ApiOkResponse({ type: ReinforcementCallView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: ReinforcementReasonDto,
  ): Promise<ReinforcementCallView> {
    return ReinforcementCallView.from(
      await this.reinforcement.cancel(id, dto.reasonCode),
    );
  }
}

/** A technician's reinforcement calls (ADR 0090): `tickets.work`. */
@ApiArea('field-team')
@RequirePermissions('tickets.work')
@Controller('maintenance/reinforcement-calls')
export class TechnicianReinforcementController {
  constructor(private readonly reinforcement: ReinforcementService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the reinforcement calls that reached me',
    description: 'Newest first, with my answer.',
  })
  @ApiOkResponse({ type: ListOf(ReinforcementCallView) })
  async mine(): Promise<ListResponse<ReinforcementCallView>> {
    return bounded(await this.reinforcement.mine(), (r) =>
      ReinforcementCallView.from(r),
    );
  }

  @Post(':id/accept')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept a reinforcement call',
    description:
      'Once, while open and before its start: a roster slot for its window is written (409 ROSTER_OVERLAP when it clashes with mine). Going on duty fills it.',
  })
  @ApiOkResponse({ type: ReinforcementCallView })
  async accept(
    @Param('id', parseId()) id: string,
  ): Promise<ReinforcementCallView> {
    return ReinforcementCallView.from(await this.reinforcement.accept(id));
  }

  @Post(':id/decline')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Decline a reinforcement call',
    description: 'Once, while open.',
  })
  @ApiOkResponse({ type: ReinforcementCallView })
  async decline(
    @Param('id', parseId()) id: string,
  ): Promise<ReinforcementCallView> {
    return ReinforcementCallView.from(await this.reinforcement.decline(id));
  }
}
