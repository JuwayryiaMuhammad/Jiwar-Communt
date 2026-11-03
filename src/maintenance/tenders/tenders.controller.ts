import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../../core/access/require-permissions.decorator';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { Public } from '../../core/common/guards/public.decorator';
import {
  ApiArea,
  NoStore,
  PublicPageHeaders,
} from '../../core/common/http/decorators';
import { ListOf, toList, type ListResponse } from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ReasonCodeDto } from '../tickets/dto/tickets.dto';
import { BidLinkService } from './bid-link.service';
import {
  AddTenderDocumentDto,
  AwardTenderDto,
  BidLinkBidDto,
  BidLinkTokenDto,
  ContractorBidDto,
  CreateTenderDto,
  InviteDto,
  TenderDeadlineDto,
  TendersQueryDto,
  UpdateTenderDto,
} from './dto/tenders.dto';
import { TenderBidsService } from './tender-bids.service';
import { TendersService } from './tenders.service';
import {
  BidLinkPageView,
  InvitationCreatedView,
  InviteeTenderView,
  TenderLinkView,
  TenderSummaryView,
  TenderView,
} from './views/tender.views';

/**
 * Tenders (ADR 0088), kept with `tenders.manage`; read by its holders and
 * by `tenders.open`'s, who open them, two people each on their own. No-store
 * where a view carries presigned URLs or a link shown once.
 */
@ApiArea('maintenance')
@Controller('staff/tenders')
export class TendersController {
  constructor(private readonly tenders: TendersService) {}

  @Get()
  @RequireAnyPermission('tenders.manage', 'tenders.open')
  @ApiOperation({ summary: 'List the tenders', description: 'Newest first.' })
  @ApiOkResponse({ type: ListOf(TenderSummaryView) })
  async list(
    @Query() q: TendersQueryDto,
  ): Promise<ListResponse<TenderSummaryView>> {
    return toList(await this.tenders.list(q), (t) => TenderSummaryView.from(t));
  }

  @Post()
  @Idempotent()
  @NoStore()
  @RequirePermissions('tenders.manage')
  @ApiOperation({ summary: 'Draft a tender' })
  @ApiCreatedResponse({ type: TenderView })
  async create(@Body() dto: CreateTenderDto): Promise<TenderView> {
    return TenderView.fromRecord(await this.tenders.create(dto));
  }

  @Get(':id')
  @NoStore()
  @RequireAnyPermission('tenders.manage', 'tenders.open')
  @ApiOperation({
    summary: 'Get a tender',
    description:
      'Its bids show who sent them and when; their amounts and terms only once it is opened.',
  })
  @ApiOkResponse({ type: TenderView })
  async get(@Param('id', parseId()) id: string): Promise<TenderView> {
    return TenderView.fromRecord(await this.tenders.get(id));
  }

  @Patch(':id')
  @NoStore()
  @RequirePermissions('tenders.manage')
  @ApiOperation({ summary: 'Change a draft’s terms' })
  @ApiOkResponse({ type: TenderView })
  async update(
    @Param('id', parseId()) id: string,
    @Body() dto: UpdateTenderDto,
  ): Promise<TenderView> {
    return TenderView.fromRecord(await this.tenders.update(id, dto));
  }

  @Post(':id/publish')
  @NoStore()
  @RequirePermissions('tenders.manage')
  @ApiOperation({ summary: 'Publish it: bids are taken until the deadline' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: TenderView })
  async publish(@Param('id', parseId()) id: string): Promise<TenderView> {
    return TenderView.fromRecord(await this.tenders.publish(id));
  }

  @Post(':id/deadline')
  @NoStore()
  @RequirePermissions('tenders.manage')
  @ApiOperation({ summary: 'Move the deadline later, before it passes' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: TenderView })
  async extend(
    @Param('id', parseId()) id: string,
    @Body() dto: TenderDeadlineDto,
  ): Promise<TenderView> {
    return TenderView.fromRecord(await this.tenders.extend(id, dto.bidsDueAt));
  }

  /** `reasonCode` from the closed list `tenderCancel`. */
  @Post(':id/cancel')
  @NoStore()
  @RequirePermissions('tenders.manage')
  @ApiOperation({ summary: 'Call the tender off' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: TenderView })
  async cancel(
    @Param('id', parseId()) id: string,
    @Body() dto: ReasonCodeDto,
  ): Promise<TenderView> {
    return TenderView.fromRecord(await this.tenders.cancel(id, dto.reasonCode));
  }

  @Post(':id/documents')
  @NoStore()
  @RequirePermissions('tenders.manage')
  @ApiOperation({ summary: 'Add a document to the tender' })
  @ApiCreatedResponse({ type: TenderView })
  async addDocument(
    @Param('id', parseId()) id: string,
    @Body() dto: AddTenderDocumentDto,
  ): Promise<TenderView> {
    return TenderView.fromRecord(await this.tenders.addDocument(id, dto));
  }

  @Delete(':id/documents/:documentId')
  @NoStore()
  @RequirePermissions('tenders.manage')
  @ApiOperation({ summary: 'Remove a document of the tender' })
  @ApiOkResponse({ type: TenderView })
  async removeDocument(
    @Param('id', parseId()) id: string,
    @Param('documentId', parseId('documentId')) documentId: string,
  ): Promise<TenderView> {
    return TenderView.fromRecord(
      await this.tenders.removeDocument(id, documentId),
    );
  }

  /**
   * A registered vendor (`vendorId`), whose contractors are told; or a
   * company that is not registered (`companyName`), whose bid link comes
   * back once (`link`).
   */
  @Post(':id/invitations')
  @NoStore()
  @RequirePermissions('tenders.manage')
  @ApiOperation({ summary: 'Invite a vendor, or make a bid link' })
  @ApiCreatedResponse({ type: TenderLinkView })
  async invite(
    @Param('id', parseId()) id: string,
    @Body() dto: InviteDto,
  ): Promise<TenderLinkView | InvitationCreatedView> {
    if (dto.vendorId !== undefined && dto.companyName !== undefined)
      throw appError.badRequest(ErrorCode.VALIDATION_FAILED, 'One of the two', {
        fields: [
          { field: 'companyName', code: FieldErrorCode.FIELD_NOT_ALLOWED },
        ],
      });
    if (dto.vendorId)
      return {
        id: (await this.tenders.inviteVendor(id, dto.vendorId)).id,
      };
    return TenderLinkView.from(
      await this.tenders.inviteByLink(id, {
        companyName: dto.companyName!,
        contactEmail: dto.contactEmail,
      }),
    );
  }

  @Post(':id/invitations/:invitationId/link')
  @NoStore()
  @RequirePermissions('tenders.manage')
  @ApiOperation({
    summary: 'Make a new bid link; the one before stops at once',
  })
  @ApiCreatedResponse({ type: TenderLinkView })
  async rotate(
    @Param('id', parseId()) id: string,
    @Param('invitationId', parseId('invitationId')) invitationId: string,
  ): Promise<TenderLinkView> {
    return TenderLinkView.from(await this.tenders.rotateLink(id, invitationId));
  }

  @Post(':id/invitations/:invitationId/revoke')
  @NoStore()
  @RequirePermissions('tenders.manage')
  @ApiOperation({
    summary: 'Revoke an invitation',
    description:
      'Its link opens nothing any more; its bid is withdrawn while bids are taken.',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: TenderView })
  async revoke(
    @Param('id', parseId()) id: string,
    @Param('invitationId', parseId('invitationId')) invitationId: string,
  ): Promise<TenderView> {
    return TenderView.fromRecord(await this.tenders.revoke(id, invitationId));
  }

  /**
   * After the deadline. The first call begins the opening; another holder's
   * confirms it and unseals the bids. The one who began it never confirms it.
   */
  @Post(':id/opening')
  @NoStore()
  @RequirePermissions('tenders.open')
  @ApiOperation({ summary: 'Open the bids, as one of two people' })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: TenderView })
  async open(@Param('id', parseId()) id: string): Promise<TenderView> {
    return TenderView.fromRecord(await this.tenders.open(id));
  }

  @Post(':id/award')
  @NoStore()
  @RequirePermissions('tenders.manage')
  @ApiOperation({
    summary: 'Award the tender: the contract is signed with the bid’s vendor',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: TenderView })
  async award(
    @Param('id', parseId()) id: string,
    @Body() dto: AwardTenderDto,
  ): Promise<TenderView> {
    return TenderView.fromRecord(await this.tenders.award(id, dto));
  }
}

/** The tenders a contractor's vendor is invited to (ADR 0088). */
@ApiArea('contractor')
@RequirePermissions('tenders.bid')
@Controller('contractor/tenders')
export class ContractorTendersController {
  constructor(private readonly bids: TenderBidsService) {}

  @Get()
  @ApiOperation({
    summary: 'List the tenders my company is invited to',
    description: 'Published ones, newest invitation first; 100 at most.',
  })
  @ApiOkResponse({ type: ListOf(InviteeTenderView) })
  async list(): Promise<ListResponse<InviteeTenderView>> {
    const now = new Date();
    return toList({ items: await this.bids.invited(), nextCursor: null }, (r) =>
      InviteeTenderView.from(r, now),
    );
  }

  /** No-store: the documents are presigned URLs. */
  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a tender my company is invited to' })
  @ApiOkResponse({ type: InviteeTenderView })
  async get(@Param('id', parseId()) id: string): Promise<InviteeTenderView> {
    return InviteeTenderView.from(await this.bids.get(id), new Date());
  }

  @Post(':id/bid')
  @NoStore()
  @ApiOperation({
    summary: 'Send my company’s bid',
    description:
      'Sealed: nobody reads its amount before the opening, me included. One live bid; withdraw it to send another.',
  })
  @ApiCreatedResponse({ type: InviteeTenderView })
  async bid(
    @Param('id', parseId()) id: string,
    @Body() dto: ContractorBidDto,
  ): Promise<InviteeTenderView> {
    return InviteeTenderView.from(await this.bids.submit(id, dto), new Date());
  }

  @Post(':id/bid/withdraw')
  @ApiOperation({ summary: 'Withdraw my company’s bid, before the deadline' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  withdraw(@Param('id', parseId()) id: string): Promise<void> {
    return this.bids.withdraw(id);
  }
}

/**
 * The page a company that is not registered opens from its bid link (ADR
 * 0088): no account, the link itself is the credential, for one tender
 * only, until it is revoked, replaced or expires. POST so the token stays
 * in bodies, never in a URL or a log.
 */
@ApiArea('public', 'public')
@Public()
@PublicPageHeaders()
@Controller('public/tender-bids')
export class BidLinkController {
  constructor(private readonly links: BidLinkService) {}

  @Post('lookup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Open a tender from its bid link' })
  @ApiOkResponse({ type: BidLinkPageView })
  async lookup(
    @Body() dto: BidLinkTokenDto,
    @Ip() ip: string,
  ): Promise<BidLinkPageView> {
    return BidLinkPageView.fromPage(
      await this.links.lookup(dto.token, ip),
      new Date(),
    );
  }

  @Post('bid')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send the company’s bid through its link',
    description: 'Sealed until the opening; one live bid.',
  })
  @ApiOkResponse({ type: BidLinkPageView })
  async bid(
    @Body() dto: BidLinkBidDto,
    @Ip() ip: string,
  ): Promise<BidLinkPageView> {
    const { token, ...bid } = dto;
    return BidLinkPageView.fromPage(
      await this.links.submit(token, ip, bid),
      new Date(),
    );
  }

  @Post('withdraw')
  @ApiOperation({ summary: 'Withdraw the company’s bid, before the deadline' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  withdraw(@Body() dto: BidLinkTokenDto, @Ip() ip: string): Promise<void> {
    return this.links.withdraw(dto.token, ip);
  }
}
