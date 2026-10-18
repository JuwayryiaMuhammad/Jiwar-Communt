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
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { EndLockdownDto, StaffLockdownsQueryDto } from './dto/lockdown.dto';
import { LockdownService } from './lockdown.service';
import { StaffLockdownView } from './views/lockdown.views';

/** The lockdown, the management's side (ADR 0053): `lockdown.end`. */
@ApiArea('lockdown')
@RequirePermissions('lockdown.end')
@Controller('staff/security/lockdowns')
export class StaffLockdownsController {
  constructor(private readonly lockdowns: LockdownService) {}

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
