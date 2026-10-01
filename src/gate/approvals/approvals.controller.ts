import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { ApiArea } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ApprovalsService, type NewRequest } from './approvals.service';
import { CreateGateRequestDto, DecideDto } from './dto/approvals.dto';
import {
  DecisionResponse,
  GuardRequestResponse,
  HostRequestResponse,
} from './views/approval.views';

/** The guard asks a household (ADR 0028). */
@ApiArea('gate')
@RequirePermissions('gate.operate')
@Controller('gate/approval-requests')
export class GuardApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Post()
  @Idempotent()
  @ApiCreatedResponse({ type: GuardRequestResponse })
  async create(
    @Body() dto: CreateGateRequestDto,
  ): Promise<GuardRequestResponse> {
    return GuardRequestResponse.from(
      await this.approvals.request(toRequest(dto)),
    );
  }

  /** Polled while waiting; applies a due timeout. */
  @Get(':id')
  @ApiOkResponse({ type: GuardRequestResponse })
  async get(@Param('id', parseId()) id: string): Promise<GuardRequestResponse> {
    return GuardRequestResponse.from(await this.approvals.forGuard(id));
  }

  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  @Idempotent()
  @ApiOkResponse({ type: GuardRequestResponse })
  async withdraw(
    @Param('id', parseId()) id: string,
  ): Promise<GuardRequestResponse> {
    return GuardRequestResponse.from(await this.approvals.withdraw(id));
  }
}

/** The household answers (capabilities.visitorsInvite on the unit). */
@ApiArea('gate-requests')
@Controller()
export class HostApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get('me/gate-requests')
  @ApiOkResponse({ type: ListOf(HostRequestResponse) })
  async mine(): Promise<ListResponse<HostRequestResponse>> {
    return bounded(await this.approvals.mine(), (r) =>
      HostRequestResponse.from(r),
    );
  }

  @Post('gate-requests/:id/decide')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: DecisionResponse })
  decide(
    @Param('id', parseId()) id: string,
    @Body() dto: DecideDto,
  ): Promise<DecisionResponse> {
    return this.approvals.decide(id, dto.decision);
  }
}

/** The fields each kind needs, as field errors. */
function toRequest(dto: CreateGateRequestDto): NewRequest {
  const missing = (field: string) => ({
    field,
    code: FieldErrorCode.FIELD_REQUIRED,
  });
  const extra = (field: string) => ({
    field,
    code: FieldErrorCode.FIELD_NOT_ALLOWED,
  });
  const fields =
    dto.kind === 'worker_off_schedule'
      ? [
          ...(dto.engagementId ? [] : [missing('engagementId')]),
          ...(dto.unitCode !== undefined ? [extra('unitCode')] : []),
          ...(dto.visitorName !== undefined ? [extra('visitorName')] : []),
          ...(dto.partySize !== undefined ? [extra('partySize')] : []),
        ]
      : [
          ...(dto.unitCode ? [] : [missing('unitCode')]),
          ...(dto.engagementId !== undefined ? [extra('engagementId')] : []),
        ];
  if (fields.length)
    throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
      fields,
    });
  return dto.kind === 'worker_off_schedule'
    ? { kind: dto.kind, engagementId: dto.engagementId! }
    : {
        kind: dto.kind,
        unitCode: dto.unitCode!,
        partySize: dto.partySize,
        visitorName: dto.visitorName,
      };
}
