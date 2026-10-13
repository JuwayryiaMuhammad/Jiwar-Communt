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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import {
  bounded,
  ListOf,
  toList,
  type ListResponse,
} from '../../core/common/http/list';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { Idempotent } from '../../core/idempotency/idempotent.decorator';
import { ClaimsService } from '../claims/claims.service';
import {
  CreatePostDto,
  HandOverDto,
  PostReasonDto,
  StaffPostsQueryDto,
} from './dto/posts.dto';
import { PostsService } from './posts.service';
import {
  PostCreatedView,
  StaffClaimView,
  StaffPostView,
} from './views/post.views';

/**
 * The staff side of the boards (ADR 0042): the lost-and-found desk with
 * its claims and handovers, and the lending board to read and to take a
 * post down from. Posts only: no conversation between residents is
 * reachable from here. Every answer is no-store.
 */
@ApiArea('neighbours')
@RequirePermissions('neighbours.handle')
@Controller('neighbours')
export class StaffPostsController {
  constructor(
    private readonly posts: PostsService,
    private readonly claims: ClaimsService,
  ) {}

  @Get('posts')
  @NoStore()
  @ApiOperation({ summary: 'List the posts of a board' })
  @ApiOkResponse({ type: ListOf(StaffPostView) })
  async list(
    @Query() q: StaffPostsQueryDto,
  ): Promise<ListResponse<StaffPostView>> {
    return toList(await this.posts.listForStaff(q), (p) =>
      StaffPostView.from(p),
    );
  }

  @Post('posts')
  @NoStore()
  @ApiOperation({ summary: 'Post a lost or found item as the management' })
  @Idempotent()
  @ApiCreatedResponse({ type: PostCreatedView })
  async create(@Body() dto: CreatePostDto): Promise<PostCreatedView> {
    return PostCreatedView.from(await this.posts.createByStaff(dto));
  }

  @Get('posts/:id')
  @NoStore()
  @ApiOperation({ summary: 'Get a post with its handover' })
  @ApiOkResponse({ type: StaffPostView })
  async get(@Param('id', parseId()) id: string): Promise<StaffPostView> {
    return StaffPostView.from(await this.posts.getForStaff(id));
  }

  @Post('posts/:id/remove')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Take a post off its board' })
  @ApiNoContentResponse()
  async remove(
    @Param('id', parseId()) id: string,
    @Body() dto: PostReasonDto,
  ): Promise<void> {
    await this.posts.remove(id, dto.reasonCode);
  }

  @Get('posts/:id/claims')
  @NoStore()
  @ApiOperation({ summary: 'List the claims on a found item' })
  @ApiOkResponse({ type: ListOf(StaffClaimView) })
  async claimsOf(
    @Param('id', parseId()) id: string,
  ): Promise<ListResponse<StaffClaimView>> {
    return bounded(await this.claims.listForPost(id), (c) =>
      StaffClaimView.from(c),
    );
  }

  /** Who it went to, by whom and when: recorded once, and the post closes. */
  @Post('posts/:id/handover')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Record the handover of a found item' })
  @ApiNoContentResponse()
  async handOver(
    @Param('id', parseId()) id: string,
    @Body() dto: HandOverDto,
  ): Promise<void> {
    await this.claims.handOver(id, dto);
  }

  @Post('claims/:id/decline')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Decline a claim on a found item' })
  @ApiNoContentResponse()
  async decline(
    @Param('id', parseId()) id: string,
    @Body() dto: PostReasonDto,
  ): Promise<void> {
    await this.claims.decline(id, dto.reasonCode);
  }
}
