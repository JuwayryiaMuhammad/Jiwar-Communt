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
import { RequirePermissions } from '../access/require-permissions.decorator';
import { ApiArea } from '../common/http/decorators';
import {
  ListOf,
  PageQueryDto,
  toList,
  type ListResponse,
} from '../common/http/list';
import { ReasonCodeOnlyDto } from '../common/http/reason.dto';
import { parseId } from '../common/validation/parse-id.pipe';
import { IdentityChangesService } from './identity-changes.service';
import {
  IdentityChangeReviewView,
  IdentityChangeView,
} from './views/identity-change.views';

/** Name and phone changes residents asked for, the management's side (ADR 0062). */
@ApiArea('registration')
@RequirePermissions('residents.manage')
@Controller('identity-changes')
export class IdentityChangesController {
  constructor(private readonly identity: IdentityChangesService) {}

  @Get()
  @ApiOperation({ summary: 'Pending name and phone change requests' })
  @ApiOkResponse({ type: ListOf(IdentityChangeReviewView) })
  async queue(
    @Query() q: PageQueryDto,
  ): Promise<ListResponse<IdentityChangeReviewView>> {
    return toList(await this.identity.queue(q), (r) =>
      IdentityChangeReviewView.fromReview(r),
    );
  }

  /** A released phone is PHONE_RELEASED: reject it instead. */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a name or phone change' })
  @ApiOkResponse({ type: IdentityChangeView })
  async approve(
    @Param('id', parseId()) id: string,
  ): Promise<IdentityChangeView> {
    return IdentityChangeView.from(await this.identity.approve(id));
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a name or phone change, with a code' })
  @ApiOkResponse({ type: IdentityChangeView })
  async reject(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeOnlyDto,
  ): Promise<IdentityChangeView> {
    return IdentityChangeView.from(await this.identity.reject(id, dto));
  }
}
