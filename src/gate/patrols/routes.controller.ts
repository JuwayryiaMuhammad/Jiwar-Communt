import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  CreateRouteDto,
  RenameRouteDto,
  RouteVersionDto,
  RoutesQueryDto,
} from './dto/routes.dto';
import { RoutesService } from './routes.service';
import { RouteDetailView, RouteView } from './views/route.views';

/** The routes a patrol walks, and their versions (ADR 0052). */
@ApiArea('patrols')
@RequirePermissions('patrols.manage')
@Controller('staff/security/patrols/routes')
export class RoutesController {
  constructor(private readonly routes: RoutesService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the routes', description: 'Newest first.' })
  @ApiOkResponse({ type: ListOf(RouteView) })
  async list(@Query() q: RoutesQueryDto): Promise<ListResponse<RouteView>> {
    return toList(await this.routes.list(q), (r) => r);
  }

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Add a route',
    description:
      'From a gate or a zone in service (POST_NOT_AVAILABLE), with its first version. Two routes in service never share a name (409 DUPLICATE_RESOURCE).',
  })
  @ApiCreatedResponse({ type: RouteDetailView })
  create(@Body() dto: CreateRouteDto): Promise<RouteDetailView> {
    return this.routes.create(dto);
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Get a route',
    description: 'Its current version and its checkpoints in order.',
  })
  @ApiOkResponse({ type: RouteDetailView })
  detail(@Param('id', parseId()) id: string): Promise<RouteDetailView> {
    return this.routes.detail(id);
  }

  @Patch(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Rename a route',
    description: 'In service only (409 PATROL_ROUTE_RETIRED).',
  })
  @ApiOkResponse({ type: RouteDetailView })
  rename(
    @Param('id', parseId()) id: string,
    @Body() dto: RenameRouteDto,
  ): Promise<RouteDetailView> {
    return this.routes.rename(id, dto);
  }

  @Post(':id/versions')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change what a route asks',
    description:
      'A new version: checkpoints, order, expected minutes and schedule. The scheduled runs nobody started are made again from it; a run under way keeps its version.',
  })
  @ApiOkResponse({ type: RouteDetailView })
  newVersion(
    @Param('id', parseId()) id: string,
    @Body() dto: RouteVersionDto,
  ): Promise<RouteDetailView> {
    return this.routes.newVersion(id, dto);
  }

  @Post(':id/retire')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retire a route',
    description:
      'Once, for good: its scheduled runs to come are cancelled; a run under way finishes.',
  })
  @ApiOkResponse({ type: RouteDetailView })
  retire(@Param('id', parseId()) id: string): Promise<RouteDetailView> {
    return this.routes.retire(id);
  }
}
