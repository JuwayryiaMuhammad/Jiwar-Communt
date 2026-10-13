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
  BoardQueryDto,
  CreateClaimDto,
  CreatePostDto,
  PostReasonDto,
} from './dto/posts.dto';
import { PostsService } from './posts.service';
import {
  BoardPostView,
  ClaimCreatedView,
  MyClaimView,
  PostCreatedView,
} from './views/post.views';

/**
 * The lost-and-found and lending boards, for residents (ADR 0042). A
 * resident's post shows the building it was posted from and never a name.
 * Every answer is no-store.
 */
@ApiArea('neighbours')
@RequirePermissions('neighbours.board')
@Controller('neighbour-posts')
export class BoardController {
  constructor(
    private readonly posts: PostsService,
    private readonly claims: ClaimsService,
  ) {}

  @Post()
  @NoStore()
  @ApiOperation({ summary: 'Post on the lost-and-found or the lending board' })
  @Idempotent()
  @ApiCreatedResponse({ type: PostCreatedView })
  async create(@Body() dto: CreatePostDto): Promise<PostCreatedView> {
    return PostCreatedView.from(await this.posts.create(dto));
  }

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Read a board, or list my own posts' })
  @ApiOkResponse({ type: ListOf(BoardPostView) })
  async list(@Query() q: BoardQueryDto): Promise<ListResponse<BoardPostView>> {
    return toList(await this.posts.board(q), (p) => BoardPostView.from(p));
  }

  @Get(':id')
  @NoStore()
  @ApiOperation({ summary: 'Get a post on a board, or one of my own' })
  @ApiOkResponse({ type: BoardPostView })
  async get(@Param('id', parseId()) id: string): Promise<BoardPostView> {
    return BoardPostView.from(await this.posts.get(id));
  }

  @Post(':id/close')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Take my post off its board' })
  @ApiNoContentResponse()
  async close(
    @Param('id', parseId()) id: string,
    @Body() dto: PostReasonDto,
  ): Promise<void> {
    await this.posts.close(id, dto.reasonCode);
  }

  /** The item is held at the management office: the staff decide the claim. */
  @Post(':id/claims')
  @NoStore()
  @ApiOperation({ summary: 'Claim a found item' })
  @Idempotent()
  @ApiCreatedResponse({ type: ClaimCreatedView })
  async claim(
    @Param('id', parseId()) id: string,
    @Body() dto: CreateClaimDto,
  ): Promise<ClaimCreatedView> {
    return ClaimCreatedView.from(await this.claims.create(id, dto));
  }
}

/** A resident's own claims on found items (ADR 0042). */
@ApiArea('neighbours')
@RequirePermissions('neighbours.board')
@Controller('neighbour-claims')
export class MyClaimsController {
  constructor(private readonly claims: ClaimsService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'List my claims on found items' })
  @ApiOkResponse({ type: ListOf(MyClaimView) })
  async list(): Promise<ListResponse<MyClaimView>> {
    return bounded(await this.claims.listMine(), (c) => MyClaimView.from(c));
  }

  @Post(':id/withdraw')
  @HttpCode(204)
  @NoStore()
  @ApiOperation({ summary: 'Withdraw my claim on a found item' })
  @ApiNoContentResponse()
  async withdraw(@Param('id', parseId()) id: string): Promise<void> {
    await this.claims.withdraw(id);
  }
}
