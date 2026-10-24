import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
} from '@nestjs/swagger';
import { IsString, IsUUID, Length } from 'class-validator';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { parseId } from '../../core/common/validation/parse-id.pipe';
import { withParams } from '../../core/common/validation/validation-errors';
import {
  OBJECTION_LIMITS,
  ObjectionsService,
  type BoardObjections,
  type MyObjection,
} from './objections.service';

export class ObjectDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    description: 'A unit the caller owns (OBJECTION_NOT_ALLOWED).',
  })
  @IsUUID()
  unitId: string;

  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: OBJECTION_LIMITS.grounds,
  })
  @IsString()
  @Length(
    1,
    OBJECTION_LIMITS.grounds,
    withParams({ min: 1, max: OBJECTION_LIMITS.grounds }),
  )
  grounds: string;
}

export class AnswerObjectionsDto {
  @ApiProperty({
    type: String,
    minLength: 1,
    maxLength: OBJECTION_LIMITS.reply,
    description:
      'The board’s reasoned answer, to every objector. Write no one’s name.',
  })
  @IsString()
  @Length(
    1,
    OBJECTION_LIMITS.reply,
    withParams({ min: 1, max: OBJECTION_LIMITS.reply }),
  )
  body: string;
}

export class ObjectionReplyView {
  @ApiProperty({ type: String })
  body: string;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;
}

/** An owner's own objection (ADR 0059). */
export class MyObjectionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  publicationId: string;
  @ApiProperty({ type: String })
  unitCode: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once cleared by the objector’s erasure.',
  })
  grounds: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;
  @ApiProperty({ type: ObjectionReplyView, nullable: true })
  answer: ObjectionReplyView | null;

  static from(r: MyObjection): MyObjectionView {
    return {
      id: r.objection.id,
      publicationId: r.objection.publicationId,
      unitCode: r.unitCode,
      grounds: r.objection.grounds,
      createdAt: r.objection.createdAt,
      answer: r.reply ? { body: r.reply.body, at: r.reply.createdAt } : null,
    };
  }
}

export class ObjectionGroundsView {
  @ApiProperty({ type: String, nullable: true })
  grounds: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;
}

/** A decision's objections as the board reads them: never whose. */
export class BoardObjectionsView {
  @ApiProperty({ type: String, format: 'uuid' })
  publicationId: string;
  @ApiProperty({ type: String, format: 'date-time' })
  until: Date;
  @ApiProperty({ type: Number })
  count: number;
  @ApiProperty({ type: [ObjectionGroundsView] })
  grounds: ObjectionGroundsView[];
  @ApiProperty({ type: ObjectionReplyView, nullable: true })
  answer: ObjectionReplyView | null;

  static from(r: BoardObjections): BoardObjectionsView {
    return {
      publicationId: r.publicationId,
      until: r.until,
      count: r.count,
      grounds: r.grounds,
      answer: r.reply ? { body: r.reply.body, at: r.reply.createdAt } : null,
    };
  }
}

/** Objections to the board's decisions, the owners' side (ADR 0059). */
@ApiArea('governance')
@RequirePermissions('governance.read')
@Controller('governance')
export class ObjectionsController {
  constructor(private readonly objections: ObjectionsService) {}

  @Post('publications/:id/objections')
  @NoStore()
  @ApiOperation({
    summary: 'Object to a decision of the board',
    description:
      'An owner, once for a unit they own (OBJECTION_EXISTS), within the compound’s objection days of its publication (OBJECTION_WINDOW_PASSED); a decision only, not archived, not answered yet (OBJECTION_NOT_OPEN). It changes nothing by itself: the board answers.',
  })
  @ApiCreatedResponse({ type: MyObjectionView })
  async object(
    @Param('id', parseId()) id: string,
    @Body() dto: ObjectDto,
  ): Promise<MyObjectionView> {
    return MyObjectionView.from(await this.objections.object(id, dto));
  }

  @Get('objections')
  @NoStore()
  @ApiOperation({
    summary: 'The caller’s objections, with the board’s answers',
  })
  @ApiOkResponse({ type: [MyObjectionView] })
  async mine(): Promise<MyObjectionView[]> {
    return (await this.objections.mine()).map((o) => MyObjectionView.from(o));
  }
}

/** Objections to the board's decisions, the board's side (ADR 0059). */
@ApiArea('governance')
@RequirePermissions('governance.board')
@Controller('board/publications')
export class BoardObjectionsController {
  constructor(private readonly objections: ObjectionsService) {}

  @Get(':id/objections')
  @NoStore()
  @ApiOperation({
    summary: 'A decision’s objections',
    description: 'How many, and their grounds; never whose.',
  })
  @ApiOkResponse({ type: BoardObjectionsView })
  async list(@Param('id', parseId()) id: string): Promise<BoardObjectionsView> {
    return BoardObjectionsView.from(await this.objections.forBoard(id));
  }

  @Post(':id/objections/answer')
  @NoStore()
  @ApiOperation({
    summary: 'Answer a decision’s objections',
    description:
      'A sitting member (BOARD_SEAT_REQUIRED), once (OBJECTIONS_ANSWERED), when there are some (OBJECTIONS_NONE): every objector is told. The decision then takes no more.',
  })
  @ApiCreatedResponse({ type: BoardObjectionsView })
  async answer(
    @Param('id', parseId()) id: string,
    @Body() dto: AnswerObjectionsDto,
  ): Promise<BoardObjectionsView> {
    return BoardObjectionsView.from(await this.objections.answer(id, dto.body));
  }
}
