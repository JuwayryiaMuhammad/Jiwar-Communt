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
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  CancelGuardTaskDto,
  CompleteGuardTaskDto,
  CreateGuardTaskDto,
  StaffGuardTasksQueryDto,
} from './dto/tasks.dto';
import { TasksService } from './tasks.service';
import { GuardTaskView, StaffGuardTaskView } from './views/task.views';

/** The guards' tasks, as the management gives them (ADR 0050). */
@ApiArea('guard-duty')
@RequirePermissions('guard_tasks.manage')
@Controller('staff/security/tasks')
export class StaffTasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Give the guards a task',
    description:
      'A closed unit to inspect (UNIT_NOT_CLOSED otherwise) or a custom task, for one guard, a gate or a zone. The guard, or the guards on shift at the post, are told (`guard_task.assigned`).',
  })
  @ApiCreatedResponse({ type: StaffGuardTaskView })
  create(@Body() dto: CreateGuardTaskDto): Promise<StaffGuardTaskView> {
    return this.tasks.create(dto);
  }

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the tasks', description: 'Newest first.' })
  @ApiOkResponse({ type: ListOf(StaffGuardTaskView) })
  async list(
    @Query() q: StaffGuardTasksQueryDto,
  ): Promise<ListResponse<StaffGuardTaskView>> {
    return toList(await this.tasks.list(q), (t) => t);
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a task' })
  @ApiOkResponse({ type: StaffGuardTaskView })
  get(@Param('id', parseId()) id: string): Promise<StaffGuardTaskView> {
    return this.tasks.get(id);
  }

  @Post(':id/cancel')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a task',
    description: 'While open or in progress (409 GUARD_TASK_CLOSED).',
  })
  @ApiOkResponse({ type: StaffGuardTaskView })
  cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: CancelGuardTaskDto,
  ): Promise<StaffGuardTaskView> {
    return this.tasks.cancel(id, dto.reasonCode);
  }
}

/** A guard's tasks (ADR 0050): `gate.operate`. */
@ApiArea('guard-duty')
@RequirePermissions('gate.operate')
@Controller('gate/tasks')
export class GuardTasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Get a task of mine or of my post',
    description: 'Mine, my post’s while on shift there, or one I took.',
  })
  @ApiOkResponse({ type: GuardTaskView })
  get(@Param('id', parseId()) id: string): Promise<GuardTaskView> {
    return this.tasks.getMine(id);
  }

  @Post(':id/take')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take a task',
    description:
      'On shift, an open task of mine or of my post: the first to take it wins (409 GUARD_TASK_ALREADY_TAKEN).',
  })
  @ApiOkResponse({ type: GuardTaskView })
  take(@Param('id', parseId()) id: string): Promise<GuardTaskView> {
    return this.tasks.take(id);
  }

  @Post(':id/complete')
  @NoStore()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a task I took',
    description:
      'An outcome of its kind, a note, photos (an inspection: one at least). An inspection’s outcome is told to the unit’s primary.',
  })
  @ApiOkResponse({ type: GuardTaskView })
  complete(
    @Param('id', parseId()) id: string,
    @Body() dto: CompleteGuardTaskDto,
  ): Promise<GuardTaskView> {
    return this.tasks.complete(id, dto);
  }
}
