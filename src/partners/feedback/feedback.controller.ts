import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { PartnerRequestsService } from '../requests/requests.service';
import { ResidentPartnerRequestView } from '../requests/views/request.views';
import { PartnerComplaintsService } from './complaints.service';
import {
  ComplainPartnerRequestDto,
  PartnerComplaintsQueryDto,
  DecideComplaintDto,
  RatePartnerRequestDto,
  RatingsQueryDto,
} from './dto/feedback.dto';
import { RatingsService } from './ratings.service';
import { ComplaintView, StaffRatingView } from './views/feedback.views';

/** The requester's rating of, and complaint about, a request (ADR 0060). */
@ApiArea('partners')
@RequirePermissions('partners.request')
@Controller('partner-requests/:id')
export class RequestFeedbackController {
  constructor(
    private readonly ratings: RatingsService,
    private readonly complaints: PartnerComplaintsService,
    private readonly requests: PartnerRequestsService,
  ) {}

  @Post('rating')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Rate my request once it is done' })
  @ApiOkResponse({ type: ResidentPartnerRequestView })
  async rate(
    @Param('id', parseId()) id: string,
    @Body() dto: RatePartnerRequestDto,
  ): Promise<ResidentPartnerRequestView> {
    await this.ratings.rate(id, dto);
    return ResidentPartnerRequestView.from(await this.requests.get(id));
  }

  @Post('complaint')
  @NoStore()
  @Idempotent()
  @ApiOperation({
    summary: 'Complain about the partner on my request: a management request',
  })
  @ApiCreatedResponse({ type: ComplaintView })
  async complain(
    @Param('id', parseId()) id: string,
    @Body() dto: ComplainPartnerRequestDto,
  ): Promise<ComplaintView> {
    return ComplaintView.from(await this.complaints.complain(id, dto));
  }
}

/** Complaints against partners, for the management to decide (ADR 0060). */
@ApiArea('partners')
@RequirePermissions('partners.manage')
@Controller('staff/partner-complaints')
export class StaffPartnerComplaintsController {
  constructor(private readonly complaints: PartnerComplaintsService) {}

  @Get()
  @NoStore()
  @ApiOperation({
    summary: 'List the complaints against partners, newest first',
  })
  @ApiOkResponse({ type: ListOf(ComplaintView) })
  async list(
    @Query() q: PartnerComplaintsQueryDto,
  ): Promise<ListResponse<ComplaintView>> {
    return toList(
      await this.complaints.staffList({
        ...q,
        decided: q.decided === undefined ? undefined : q.decided === 'true',
      }),
      (c) => ComplaintView.from(c),
    );
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a complaint against a partner' })
  @ApiOkResponse({ type: ComplaintView })
  async get(@Param('id', parseId()) id: string): Promise<ComplaintView> {
    return ComplaintView.from(await this.complaints.staffGet(id));
  }

  @Post(':id/decide')
  @HttpCode(200)
  @NoStore()
  @ApiOperation({ summary: 'Decide a complaint, once' })
  @ApiOkResponse({ type: ComplaintView })
  async decide(
    @Param('id', parseId()) id: string,
    @Body() dto: DecideComplaintDto,
  ): Promise<ComplaintView> {
    return ComplaintView.from(await this.complaints.decide(id, dto));
  }
}

/** The partners' ratings, for the management (ADR 0060). */
@ApiArea('partners')
@RequirePermissions('partners.manage')
@Controller('staff/partner-ratings')
export class StaffRatingsController {
  constructor(private readonly ratings: RatingsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List the ratings, newest first' })
  @ApiOkResponse({ type: ListOf(StaffRatingView) })
  async list(
    @Query() q: RatingsQueryDto,
  ): Promise<ListResponse<StaffRatingView>> {
    return toList(await this.ratings.staffList(q), (r) =>
      StaffRatingView.fromStaff(r),
    );
  }
}
