import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { CapabilitiesService } from '../capabilities/capabilities.service';
import { CapabilitiesView } from '../capabilities/views/capabilities.view';
import { DelegationsService } from '../households/delegations.service';
import { MemberPermissionsService } from '../households/member-permissions.service';
import { ResidentsService } from './residents.service';
import {
  MyDelegationView,
  MyPermissionsView,
  MyUnitView,
} from './views/me-units.views';

/** The caller's units and what they may do on each (any tenant account). */
@ApiArea('me')
@Controller('me')
export class MeUnitsController {
  constructor(
    private readonly residents: ResidentsService,
    private readonly capabilities: CapabilitiesService,
    private readonly permissions: MemberPermissionsService,
    private readonly delegations: DelegationsService,
  ) {}

  /** Occupancies, then a family account's memberships. */
  @Get('units')
  @ApiOkResponse({ type: ListOf(MyUnitView) })
  async units(): Promise<ListResponse<MyUnitView>> {
    return bounded(await this.residents.myUnits(), (u) => MyUnitView.from(u));
  }

  /**
   * **What the apps use to show or hide features** on this unit (ADR 0020).
   * A unit the caller has no place in is UNIT_NOT_FOUND.
   */
  @Get('units/:unitId/capabilities')
  @ApiOkResponse({ type: CapabilitiesView })
  async capabilitiesOn(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<CapabilitiesView> {
    return CapabilitiesView.from(await this.capabilities.mine(unitId));
  }

  /** A household member's own permissions on the unit, and the baseline. */
  @Get('units/:unitId/permissions')
  @ApiOkResponse({ type: MyPermissionsView })
  async permissionsOn(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<MyPermissionsView> {
    return MyPermissionsView.from(await this.permissions.myPermissions(unitId));
  }

  /** Live delegations the caller holds or gave. */
  @Get('delegations')
  @ApiOkResponse({ type: ListOf(MyDelegationView) })
  async myDelegations(): Promise<ListResponse<MyDelegationView>> {
    return bounded(await this.delegations.mine(), (d) =>
      MyDelegationView.from(d),
    );
  }
}
