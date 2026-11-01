import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import {
  BINDABLE_TYPES,
  type BindableType,
} from '../../core/board-matters/board-matters';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  type ListResponse,
} from '../../core/common/http/list';
import { withParams } from '../../core/common/validation/validation-errors';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { BoardAuthority, type BoardAuthorizationRead } from './board-authority';

const BOOL = ['true', 'false'] as const;
const USES = ['invoice_dispute', 'plan_request', 'invoice'] as const;

export class BoardAuthorizationsQueryDto {
  @ApiProperty({
    required: false,
    enum: BINDABLE_TYPES,
    enumName: 'BindableApprovalType',
  })
  @IsOptional()
  @IsIn(BINDABLE_TYPES, withParams({ allowed: [...BINDABLE_TYPES] }))
  type?: BindableType;

  @ApiProperty({
    required: false,
    enum: BOOL,
    description: '`true`: only those not used yet.',
  })
  @IsOptional()
  @IsIn(BOOL, withParams({ allowed: [...BOOL] }))
  unused?: (typeof BOOL)[number];
}

export class AuthorizationUseView {
  @ApiProperty({ enum: USES })
  type: (typeof USES)[number];
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
}

/** What an approved waiver or payment plan request lets finance do once (ADR 0073). */
export class BoardAuthorizationView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  approvalRequestId: string;
  @ApiProperty({ enum: BINDABLE_TYPES, enumName: 'BindableApprovalType' })
  type: BindableType;
  @ApiProperty({ type: String, description: 'EGP, the board’s approved cost.' })
  amount: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  usedAt: Date | null;
  @ApiProperty({ type: () => AuthorizationUseView, nullable: true })
  usedBy: AuthorizationUseView | null;

  static from(r: BoardAuthorizationRead): BoardAuthorizationView {
    return Object.assign(new BoardAuthorizationView(), {
      ...r,
      usedBy: r.usedBy ? { ...r.usedBy } : null,
    });
  }
}

/** The board's authorizations for a waiver or a plan (ADR 0073). */
@ApiArea('finance')
@RequirePermissions('finance.invoice')
@Controller('staff/finance/board-authorizations')
export class BoardAuthorizationsController {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly authority: BoardAuthority,
  ) {}

  /** At most the 100 newest. */
  @Get()
  @ApiOperation({
    summary: 'List what the board approved for a waiver or a payment plan',
  })
  @NoStore()
  @ApiOkResponse({ type: ListOf(BoardAuthorizationView) })
  async list(
    @Query() q: BoardAuthorizationsQueryDto,
  ): Promise<ListResponse<BoardAuthorizationView>> {
    const rows = await this.tenantTx.withTenantTx((tx) =>
      this.authority.list(tx, { type: q.type, unused: q.unused === 'true' }),
    );
    return bounded(rows, (r) => BoardAuthorizationView.from(r));
  }
}
