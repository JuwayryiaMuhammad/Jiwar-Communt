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
import { CheckpointsService } from './checkpoints.service';
import {
  CheckpointsQueryDto,
  CreateCheckpointDto,
  UpdateCheckpointDto,
} from './dto/checkpoints.dto';
import { CheckpointSecretView, CheckpointView } from './views/checkpoint.views';

/** The checkpoints a patrol scans, and their QR (ADR 0052). */
@ApiArea('patrols')
@RequirePermissions('patrols.manage')
@Controller('staff/security/patrols/checkpoints')
export class CheckpointsController {
  constructor(private readonly checkpoints: CheckpointsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the checkpoints',
    description: 'Newest first; never a token.',
  })
  @ApiOkResponse({ type: ListOf(CheckpointView) })
  async list(
    @Query() q: CheckpointsQueryDto,
  ): Promise<ListResponse<CheckpointView>> {
    return toList(await this.checkpoints.list(q), (c) => c);
  }

  @Post()
  @NoStore()
  @ApiOperation({
    summary: 'Add a checkpoint',
    description:
      'At a gate or a zone in service (POST_NOT_AVAILABLE). Answers its QR payload once: print it now, or reissue later. Two checkpoints in service never share a name (409 DUPLICATE_RESOURCE).',
  })
  @ApiCreatedResponse({ type: CheckpointSecretView })
  create(@Body() dto: CreateCheckpointDto): Promise<CheckpointSecretView> {
    return this.checkpoints.create(dto);
  }

  @Patch(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Rename or place a checkpoint',
    description:
      'In service only (409 PATROL_CHECKPOINT_RETIRED). Its post never changes.',
  })
  @ApiOkResponse({ type: CheckpointView })
  update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateCheckpointDto,
  ): Promise<CheckpointView> {
    return this.checkpoints.update(id, dto);
  }

  @Post(':id/reissue')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Print a new QR',
    description:
      'A new payload, answered once; the old printout stops scanning at once.',
  })
  @ApiOkResponse({ type: CheckpointSecretView })
  reissue(@Param('id', parseId()) id: string): Promise<CheckpointSecretView> {
    return this.checkpoints.reissue(id);
  }

  @Post(':id/retire')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retire a checkpoint',
    description:
      'Once, for good; its scans stay. Not while a route in service walks it (409 PATROL_CHECKPOINT_IN_USE, params.routes).',
  })
  @ApiOkResponse({ type: CheckpointView })
  retire(@Param('id', parseId()) id: string): Promise<CheckpointView> {
    return this.checkpoints.retire(id);
  }
}
