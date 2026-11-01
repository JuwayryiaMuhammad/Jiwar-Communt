import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { ApiArea, NoStore } from '../common/http/decorators';
import { bounded, ListOf, type ListResponse } from '../common/http/list';
import { parseId } from '../common/validation/parse-id.pipe';
import { DeputiesService } from './deputies.service';
import { AppointDeputyDto } from './dto/deputies.dto';
import { RequirePermissions } from './require-permissions.decorator';
import { DeputyView } from './views/deputy.views';

/**
 * Deputies (ADR 0073): a manager names who decides in their place while
 * away. Reading and ending one is either account's; naming one is
 * `deputies.manage`'s.
 */
@ApiArea('staff')
@Controller('staff/deputies')
export class DeputiesController {
  constructor(private readonly deputies: DeputiesService) {}

  @Get()
  @ApiOperation({ summary: 'My deputyships, as principal or deputy' })
  @NoStore()
  @ApiOkResponse({ type: ListOf(DeputyView) })
  async mine(): Promise<ListResponse<DeputyView>> {
    return bounded(await this.deputies.mine(), (d) => DeputyView.from(d));
  }

  @Post()
  @RequirePermissions('deputies.manage')
  @ApiOperation({
    summary: 'Name a deputy who decides in my place until a time',
    description:
      'The deputy gains the permissions and I lose them until it ends. One live deputy per principal (DEPUTY_ALREADY_SET) and one live deputyship per deputy (DEPUTY_BUSY). The deputy is told.',
  })
  @NoStore()
  @ApiCreatedResponse({ type: DeputyView })
  async appoint(@Body() dto: AppointDeputyDto): Promise<DeputyView> {
    return DeputyView.from(
      await this.deputies.appoint({
        deputyAccountId: dto.deputyAccountId,
        permissions: dto.permissions,
        endsAt: new Date(dto.endsAt),
      }),
    );
  }

  @Post(':id/end')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'End a deputyship early, as its principal or its deputy',
    description: 'Once (DEPUTY_ENDED). The other account is told.',
  })
  @NoStore()
  @ApiOkResponse({ type: DeputyView })
  async end(@Param('id', parseId()) id: string): Promise<DeputyView> {
    return DeputyView.from(await this.deputies.end(id));
  }
}
