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
import { ReasonDto, reasonOf } from '../../core/common/http/reason.dto';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { MemberGrantResponse } from '../residents/views/me-units.views';
import {
  DecideDto,
  GrantDto,
  RevokeByManagementDto,
  RevokeDto,
} from './dto/member-permissions.dto';
import { MemberPermissionsService } from './member-permissions.service';
import {
  DeferredActionResponse,
  MemberPermissionsResponse,
} from './views/member-permissions.views';

/**
 * What each household member may use (ADR 0021): the primary or a
 * `household` delegate grants and revokes; finance is the primary's alone.
 */
@ApiArea('member-permissions')
@Controller()
export class MemberPermissionsController {
  constructor(private readonly permissions: MemberPermissionsService) {}

  @RequirePermissions('household.manage')
  @Get('household/members/:id/permissions')
  @ApiOkResponse({ type: MemberPermissionsResponse })
  async get(
    @Param('id', parseId()) id: string,
  ): Promise<MemberPermissionsResponse> {
    return MemberPermissionsResponse.from(
      await this.permissions.memberPermissions(id),
    );
  }

  /** A second grant of the same permission changes its cap. */
  @RequirePermissions('household.manage')
  @Post('household/members/:id/permissions/grant')
  @ApiCreatedResponse({ type: MemberGrantResponse })
  async grant(
    @Param('id', parseId()) id: string,
    @Body() dto: GrantDto,
  ): Promise<MemberGrantResponse> {
    return MemberGrantResponse.from(
      await this.permissions.grant(id, dto.permission, {
        capPerOperation: dto.capPerOperation,
      }),
    );
  }

  /** The member is told, with the reason. */
  @RequirePermissions('household.manage')
  @Post('household/members/:id/permissions/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async revoke(
    @Param('id', parseId()) id: string,
    @Body() dto: RevokeDto,
  ): Promise<void> {
    await this.permissions.revoke(id, dto.permission, reasonOf(dto));
  }

  /** Everything granted; the baseline always remains. */
  @RequirePermissions('household.manage')
  @Post('household/members/:id/permissions/revoke-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async revokeAll(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonDto,
  ): Promise<void> {
    await this.permissions.revokeAll(id, reasonOf(dto));
  }

  /** The manager's decision, e.g. during a separation. */
  @RequirePermissions('household.override')
  @Post('household/members/:id/permissions/revoke-by-management')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async revokeByManagement(
    @Param('id', parseId()) id: string,
    @Body() dto: RevokeByManagementDto,
  ): Promise<void> {
    await this.permissions.revokeByManagement(
      id,
      dto.permission,
      reasonOf(dto),
    );
  }

  /** Members' requests waiting for the primary. */
  @RequirePermissions('household.manage')
  @Get('units/:unitId/deferred-actions')
  @ApiOkResponse({ type: ListOf(DeferredActionResponse) })
  async deferred(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ListResponse<DeferredActionResponse>> {
    return bounded(await this.permissions.deferredActions(unitId), (d) =>
      DeferredActionResponse.from(d),
    );
  }

  @RequirePermissions('household.manage')
  @Post('deferred-actions/:id/decide')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async decide(
    @Param('id', parseId()) id: string,
    @Body() dto: DecideDto,
  ): Promise<void> {
    await this.permissions.decideDeferredAction(
      id,
      dto.decision,
      dto.decision === 'decline' ? reasonOf(dto) : undefined,
    );
  }
}
