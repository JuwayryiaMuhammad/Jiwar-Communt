import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { ApiArea } from '../common/http/decorators';
import { bounded, ListOf, type ListResponse } from '../common/http/list';
import { parseId } from '../common/validation/parse-id.pipe';
import { ReplacePermissionsDto } from './dto/roles.dto';
import { PERMISSIONS } from './permissions';
import { RequirePermissions } from './require-permissions.decorator';
import { RolesService } from './roles.service';
import { PermissionView, RoleView } from './views/roles.views';

/** The compound's roles and the code permission catalog (ADR 0010). */
@ApiArea('admin')
@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @RequirePermissions('roles.read')
  @Get('roles')
  @ApiOperation({ summary: "List the compound's roles" })
  @ApiOkResponse({ type: ListOf(RoleView) })
  async list(): Promise<ListResponse<RoleView>> {
    return bounded(await this.roles.list(), (r) => RoleView.from(r));
  }

  @RequirePermissions('roles.read')
  @Get('roles/:id')
  @ApiOperation({ summary: 'Get one role with its permissions' })
  @ApiOkResponse({ type: RoleView })
  async get(@Param('id', parseId()) id: string): Promise<RoleView> {
    return RoleView.from(await this.roles.get(id));
  }

  /** Applies on every holder's next request (versioned cache). */
  @RequirePermissions('roles.manage')
  @Put('roles/:id/permissions')
  @ApiOperation({ summary: "Replace a role's permissions" })
  @ApiOkResponse({ type: RoleView })
  async replace(
    @Param('id', parseId()) id: string,
    @Body() dto: ReplacePermissionsDto,
  ): Promise<RoleView> {
    return RoleView.from(
      await this.roles.replacePermissions(id, dto.permissions),
    );
  }

  @RequirePermissions('roles.read')
  @Get('permissions')
  @ApiOperation({ summary: 'List the permission catalog' })
  @ApiOkResponse({ type: ListOf(PermissionView) })
  catalog(): ListResponse<PermissionView> {
    return bounded(Object.entries(PERMISSIONS), (e) => PermissionView.from(e));
  }
}
