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
  ApiNoContentResponse,
  ApiOkResponse,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { DelegationsService } from './delegations.service';
import { CreateDelegationDto } from './dto/delegations.dto';
import {
  CreatedDelegationView,
  UnitDelegationView,
} from './views/delegations.views';

/** The primary delegates the household or the workers to an adult member (ADR 0016). */
@ApiArea('delegations')
@RequirePermissions('household.delegate')
@Controller()
export class DelegationsController {
  constructor(private readonly delegations: DelegationsService) {}

  @Get('units/:unitId/delegations')
  @ApiOkResponse({ type: ListOf(UnitDelegationView) })
  async list(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ListResponse<UnitDelegationView>> {
    return bounded(await this.delegations.listForUnit(unitId), (d) =>
      UnitDelegationView.from(d),
    );
  }

  /** Both sides are emailed. */
  @Post('units/:unitId/delegations')
  @ApiCreatedResponse({ type: CreatedDelegationView })
  async create(
    @Param('unitId', parseId('unitId')) unitId: string,
    @Body() dto: CreateDelegationDto,
  ): Promise<CreatedDelegationView> {
    return CreatedDelegationView.from(
      await this.delegations.create(
        unitId,
        dto.delegateAccountId,
        dto.scopes,
        dto.expiresAt,
      ),
    );
  }

  @Post('delegations/:id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async revoke(@Param('id', parseId()) id: string): Promise<void> {
    await this.delegations.revoke(id);
  }
}
