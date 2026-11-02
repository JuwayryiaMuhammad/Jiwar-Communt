import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import {
  EndLockdownDto,
  StaffLockdownsQueryDto,
  StartLockdownDto,
} from './dto/lockdown.dto';
import { LockdownService } from './lockdown.service';
import { StaffLockdownView } from './views/lockdown.views';

/**
 * The lockdown, the management's side (ADR 0053): `lockdown.end`; and its
 * start from the office (ADR 0087): `lockdown.start`, the manager only.
 */
@ApiArea('lockdown')
@RequirePermissions('lockdown.end')
@Controller('staff/security/lockdowns')
export class StaffLockdownsController {
  constructor(private readonly lockdowns: LockdownService) {}

  @Post()
  @RequirePermissions('lockdown.start')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Lock one gate or all down from the office',
    description:
      'The management (ADR 0087), with a reason code and the typed confirmation `LOCKDOWN`, as a guard does: immediate, no shift. The guards on shift and the management get a critical push, every resident a generic one. One live per scope: a repeat answers 200 with it.',
  })
  @ApiCreatedResponse({ type: StaffLockdownView })
  @ApiOkResponse({ type: StaffLockdownView, description: 'The live one.' })
  async start(
    @Body() dto: StartLockdownDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StaffLockdownView> {
    const { record, created } = await this.lockdowns.startFromOffice(dto);
    if (!created) res.status(HttpStatus.OK);
    return StaffLockdownView.from(record);
  }

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the lockdowns',
    description: 'Newest first; `status=live` for those still holding.',
  })
  @ApiOkResponse({ type: ListOf(StaffLockdownView) })
  async list(
    @Query() q: StaffLockdownsQueryDto,
  ): Promise<ListResponse<StaffLockdownView>> {
    return toList(await this.lockdowns.list(q), (r) =>
      StaffLockdownView.from(r),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a lockdown, with its overrides' })
  @ApiOkResponse({ type: StaffLockdownView })
  async get(@Param('id', parseId()) id: string): Promise<StaffLockdownView> {
    return StaffLockdownView.from(await this.lockdowns.get(id));
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'End a lockdown',
    description:
      'The management only, with a reason code and a note of its own. The guards on shift and the management are told; the residents too once no lockdown is left.',
  })
  @ApiOkResponse({ type: StaffLockdownView })
  async end(
    @Param('id', parseId()) id: string,
    @Body() dto: EndLockdownDto,
  ): Promise<StaffLockdownView> {
    return StaffLockdownView.from(await this.lockdowns.end(id, dto));
  }
}
