import { Controller, Get, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
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
  ServiceStandingView,
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
  @ApiOperation({ summary: 'List my units and household memberships' })
  @ApiOkResponse({ type: ListOf(MyUnitView) })
  async units(): Promise<ListResponse<MyUnitView>> {
    return bounded(await this.residents.myUnits(), (u) => MyUnitView.from(u));
  }

  /**
   * **What the apps use to show or hide features** on this unit (ADR 0020).
   * A unit the caller has no place in is UNIT_NOT_FOUND.
   */
  @Get('units/:unitId/capabilities')
  @ApiOperation({
    summary: 'What I may do on one of my units (feature toggles)',
  })
  @ApiOkResponse({ type: CapabilitiesView })
  async capabilitiesOn(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<CapabilitiesView> {
    return CapabilitiesView.from(await this.capabilities.mine(unitId));
  }

  /**
   * The services the unit is suspended from (ADR 0058), why, until when,
   * and how each is restored. Empty when none is.
   */
  @Get('units/:unitId/service-standing')
  @ApiOperation({
    summary: 'What services my unit is suspended from, and how to restore them',
  })
  @NoStore()
  @ApiOkResponse({ type: ListOf(ServiceStandingView) })
  async standing(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<ListResponse<ServiceStandingView>> {
    return bounded(await this.capabilities.standing(unitId), (s) =>
      ServiceStandingView.from(s),
    );
  }

  /** A household member's own permissions on the unit, and the baseline. */
  @Get('units/:unitId/permissions')
  @ApiOperation({ summary: 'My household permissions on a unit' })
  @ApiOkResponse({ type: MyPermissionsView })
  async permissionsOn(
    @Param('unitId', parseId('unitId')) unitId: string,
  ): Promise<MyPermissionsView> {
    return MyPermissionsView.from(await this.permissions.myPermissions(unitId));
  }

  /** Live delegations the caller holds or gave. */
  @Get('delegations')
  @ApiOperation({ summary: 'List the delegations I hold or gave' })
  @ApiOkResponse({ type: ListOf(MyDelegationView) })
  async myDelegations(): Promise<ListResponse<MyDelegationView>> {
    return bounded(await this.delegations.mine(), (d) =>
      MyDelegationView.from(d),
    );
  }
}
