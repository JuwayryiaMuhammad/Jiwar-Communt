import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import {
  CreatePreventiveServiceDto,
  UpdatePreventiveServiceDto,
} from './dto/preventive-services.dto';
import { PreventiveServicesService } from './preventive-services.service';
import {
  PreventiveServiceOptionView,
  PreventiveServiceView,
} from './views/preventive-service.views';

/** The compound's preventive services, for the manager (ADR 0038). */
@ApiArea('maintenance')
@RequirePermissions('maintenance.manage')
@Controller('maintenance/preventive-services')
export class PreventiveServicesController {
  constructor(private readonly services: PreventiveServicesService) {}

  @Get()
  @ApiOperation({ summary: 'List preventive services' })
  @ApiOkResponse({ type: ListOf(PreventiveServiceView) })
  async list(): Promise<ListResponse<PreventiveServiceView>> {
    return bounded(await this.services.list(), (s) =>
      PreventiveServiceView.from(s),
    );
  }

  @Post()
  @ApiOperation({ summary: 'Create a preventive service' })
  @ApiCreatedResponse({ type: PreventiveServiceView })
  async create(
    @Body() dto: CreatePreventiveServiceDto,
  ): Promise<PreventiveServiceView> {
    return PreventiveServiceView.from(await this.services.create(dto));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a preventive service' })
  @ApiOkResponse({ type: PreventiveServiceView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdatePreventiveServiceDto,
  ): Promise<PreventiveServiceView> {
    return PreventiveServiceView.from(await this.services.update(id, dto));
  }
}

/** What a resident may book a check-up for. */
@ApiArea('tickets')
@RequirePermissions('tickets.create')
@Controller('preventive-services')
export class PreventiveServiceOptionsController {
  constructor(private readonly services: PreventiveServicesService) {}

  @Get()
  @ApiOperation({ summary: 'List the preventive services I may book' })
  @ApiOkResponse({ type: ListOf(PreventiveServiceOptionView) })
  async list(): Promise<ListResponse<PreventiveServiceOptionView>> {
    return bounded(await this.services.options(), (s) =>
      PreventiveServiceOptionView.from(s),
    );
  }
}
