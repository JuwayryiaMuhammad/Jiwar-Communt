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
import {
  ApprovePermitDto,
  RejectPermitDto,
  RevokePermitDto,
  StaffPermitsQueryDto,
  StaffRemoveWorkerDto,
  StopWorkDto,
} from './dto/permits.dto';
import { StaffPermitsService } from './staff-permits.service';
import { StaffPermitView } from './views/permit.views';
import { PermitWorkStopsService } from './permit-work-stops.service';

/** The units' permits, the management's side (ADR 0049). */
@ApiArea('permits')
@RequirePermissions('permits.manage')
@Controller('staff/unit-permits')
export class StaffPermitsController {
  constructor(
    private readonly permits: StaffPermitsService,
    private readonly stops: PermitWorkStopsService,
  ) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the units’ permits',
    description:
      'Newest first; `status=pending` is the queue to decide, `live=true` what is in force now. Workers’ faces are not presigned here: get one permit for them.',
  })
  @ApiOkResponse({ type: ListOf(StaffPermitView) })
  async list(
    @Query() q: StaffPermitsQueryDto,
  ): Promise<ListResponse<StaffPermitView>> {
    return toList(await this.permits.list(q), (r) => StaffPermitView.from(r));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({
    summary: 'Get a permit',
    description:
      'With its workers’ faces, its guests, its items and photo, and the management’s notes.',
  })
  @ApiOkResponse({ type: StaffPermitView })
  async get(@Param('id', parseId()) id: string): Promise<StaffPermitView> {
    const r = await this.permits.get(id);
    return StaffPermitView.from(r, await this.permits.lockouts(r));
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Approve a pending permit',
    description:
      'Decided already: PERMIT_NOT_PENDING. Its window over: PERMIT_NOT_ACTIVE. The requester is told.',
  })
  @ApiOkResponse({ type: StaffPermitView })
  async approve(
    @Param('id', parseId()) id: string,
    @Body() dto: ApprovePermitDto,
  ): Promise<StaffPermitView> {
    return StaffPermitView.from(await this.permits.approve(id, dto));
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Reject a pending permit, with a reason code',
    description:
      'Decided already: PERMIT_NOT_PENDING. The requester is told the reason’s code, never the note.',
  })
  @ApiOkResponse({ type: StaffPermitView })
  async reject(
    @Param('id', parseId()) id: string,
    @Body() dto: RejectPermitDto,
  ): Promise<StaffPermitView> {
    return StaffPermitView.from(await this.permits.reject(id, dto));
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Revoke an approved permit in force, with a reason code',
    description:
      'From then on the guard refuses it (`revoked`). Not approved, over or used: PERMIT_NOT_ACTIVE. The requester is told.',
  })
  @ApiOkResponse({ type: StaffPermitView })
  async revoke(
    @Param('id', parseId()) id: string,
    @Body() dto: RevokePermitDto,
  ): Promise<StaffPermitView> {
    return StaffPermitView.from(await this.permits.revoke(id, dto));
  }

  @Post(':id/stop-work')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Stop the work of a works permit',
    description:
      'An approved works permit in force (PERMIT_NOT_ACTIVE otherwise), with a code from `permitWorkStop`. Its workers are refused at the gate (`work_stopped`) until it is resumed, revoked or cancelled. Stopped already: PERMIT_WORK_STOPPED. The requester and the primary are told.',
  })
  @ApiOkResponse({ type: StaffPermitView })
  async stopWork(
    @Param('id', parseId()) id: string,
    @Body() dto: StopWorkDto,
  ): Promise<StaffPermitView> {
    return StaffPermitView.from(
      await this.stops.stop(id, dto.reasonCode, 'staff'),
    );
  }

  @Post(':id/resume-work')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Let the stopped work go on',
    description:
      'Its workers come in again. Not stopped: PERMIT_WORK_NOT_STOPPED. The requester and the primary are told.',
  })
  @ApiOkResponse({ type: StaffPermitView })
  async resumeWork(
    @Param('id', parseId()) id: string,
  ): Promise<StaffPermitView> {
    return StaffPermitView.from(await this.stops.resume(id));
  }

  @Post(':id/workers/:workerId/unlock')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Unlock a contractor worker locked out of the ID check',
    description:
      'Ten wrong last-fours in a day lock a worker out (PERMIT_ID_LOCKED); a guard’s typing errors must not cost them a working day.',
  })
  @ApiOkResponse({ type: StaffPermitView })
  async unlockWorker(
    @Param('id', parseId()) id: string,
    @Param('workerId', parseId('workerId')) workerId: string,
  ): Promise<StaffPermitView> {
    const r = await this.permits.unlockWorker(id, workerId);
    return StaffPermitView.from(r, await this.permits.lockouts(r));
  }

  @Post(':id/guards/:guardId/unlock')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Unlock a guard locked out of the ID check',
    description:
      'Five wrong last-fours in 15 minutes lock a guard out (PERMIT_ID_LOCKED), on every permit. From a works permit’s detail, which lists the guards locked out.',
  })
  @ApiOkResponse({ type: StaffPermitView })
  async unlockGuard(
    @Param('id', parseId()) id: string,
    @Param('guardId', parseId('guardId')) guardId: string,
  ): Promise<StaffPermitView> {
    const r = await this.permits.unlockGuard(id, guardId);
    return StaffPermitView.from(r, await this.permits.lockouts(r));
  }

  @Post(':id/workers/:workerId/remove')
  @HttpCode(HttpStatus.OK)
  @NoStore()
  @ApiOperation({
    summary: 'Take a contractor worker off a works permit, with a reason code',
    description: 'From then on the guard refuses them (`worker_removed`).',
  })
  @ApiOkResponse({ type: StaffPermitView })
  async removeWorker(
    @Param('id', parseId()) id: string,
    @Param('workerId', parseId('workerId')) workerId: string,
    @Body() dto: StaffRemoveWorkerDto,
  ): Promise<StaffPermitView> {
    return StaffPermitView.from(
      await this.permits.removeWorker(id, workerId, dto),
    );
  }
}
