import { ApiProperty } from '@nestjs/swagger';
import {
  NeighbourClaimStatus,
  NeighbourPostKind,
  NeighbourSide,
  type NeighbourItemClaim,
  type NeighbourPost,
} from '@prisma/client';
import { accountRef, AccountRefView } from '../../../core/common/http/personal';
import type { ClaimRead, StaffClaimRead } from '../../claims/claims.service';
import {
  boardOf,
  BOARDS,
  isClaimable,
  POST_STATES,
  type Board,
  type PostState,
} from '../post-rules';
import type {
  HandoverRead,
  PhotoRead,
  PostRead,
  StaffPostRead,
} from '../posts.service';

/** The answer to posting: enough to show and to fetch it. No words. */
export class PostCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: NeighbourPostKind, enumName: 'NeighbourPostKind' })
  kind: NeighbourPostKind;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(p: NeighbourPost): PostCreatedView {
    return {
      id: p.id,
      kind: p.kind,
      expiresAt: p.expiresAt,
      createdAt: p.createdAt,
    };
  }
}

export class PostPhotoView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    description: 'image/jpeg, image/png or image/webp.',
  })
  contentType: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A presigned GET, valid until `expiresAt`. Null when gone.',
  })
  url: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt: Date | null;

  static from(p: PhotoRead): PostPhotoView {
    return {
      id: p.id,
      contentType: p.contentType,
      url: p.read?.url ?? null,
      expiresAt: p.read?.expiresAt ?? null,
    };
  }
}

/**
 * Who posted, as other residents are told (ADR 0042): the management, or
 * "a resident of building X". Never a name, a unit or an account id.
 */
export class PostAuthorLabelView {
  @ApiProperty({
    enum: ['management', 'resident'],
    description: '`management`: posted by the staff.',
  })
  kind: 'management' | 'resident';
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The building the resident posted from. Null for the management, and for a unit that names no building.',
  })
  building: string | null;
}

/** What every reader sees of a post. */
class PostBaseView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: BOARDS })
  board: Board;
  @ApiProperty({ enum: NeighbourPostKind, enumName: 'NeighbourPostKind' })
  kind: NeighbourPostKind;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null once its author was erased.',
  })
  body: string | null;
  @ApiProperty({ type: String, nullable: true })
  place: string | null;
  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description: 'The day it was lost or found.',
  })
  occurredOn: string | null;
  @ApiProperty({ type: [PostPhotoView] })
  photos: PostPhotoView[];
  @ApiProperty({
    enum: POST_STATES,
    description:
      '`expired`: its day passed. A resident sees it only on their own posts.',
  })
  state: PostState;
  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  protected static base(r: {
    post: NeighbourPost;
    state: PostState;
    photos: PhotoRead[];
  }): PostBaseView {
    const p = r.post;
    return {
      id: p.id,
      board: boardOf(p.kind),
      kind: p.kind,
      body: p.body,
      place: p.place,
      occurredOn: p.occurredOn ? p.occurredOn.toISOString().slice(0, 10) : null,
      photos: r.photos.map((x) => PostPhotoView.from(x)),
      state: r.state,
      expiresAt: p.expiresAt,
      createdAt: p.createdAt,
    };
  }
}

export class MyClaimRefView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: NeighbourClaimStatus, enumName: 'NeighbourClaimStatus' })
  status: NeighbourClaimStatus;
}

/** A post as a resident reads it on a board, or among their own. */
export class BoardPostView extends PostBaseView {
  @ApiProperty({ type: PostAuthorLabelView })
  author: PostAuthorLabelView;
  @ApiProperty({ type: Boolean, description: 'The caller posted it.' })
  mine: boolean;
  @ApiProperty({
    type: Boolean,
    description:
      'A found item on its board, not the caller’s own: it may be claimed at the office.',
  })
  claimable: boolean;
  @ApiProperty({
    type: MyClaimRefView,
    nullable: true,
    description: 'The caller’s latest claim on it.',
  })
  myClaim: MyClaimRefView | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Why it closed, on the caller’s own post alone.',
  })
  closeReason: string | null;

  static from(r: PostRead): BoardPostView {
    return {
      ...PostBaseView.base(r),
      author: {
        kind: r.post.authorSide === 'staff' ? 'management' : 'resident',
        building: r.authorUnit?.building ?? null,
      },
      mine: r.mine,
      claimable: isClaimable(r.post.kind) && r.state === 'open' && !r.mine,
      myClaim: r.myClaim,
      closeReason: r.mine ? r.post.closeReason : null,
    };
  }
}

export class PostUnitRefView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  code: string;
  @ApiProperty({ type: String, nullable: true })
  building: string | null;
}

export class HandoverView {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The claim it settled; null for someone who came without one.',
  })
  claimId: string | null;
  @ApiProperty({ type: AccountRefView })
  recipient: AccountRefView;
  @ApiProperty({ type: AccountRefView })
  handedBy: AccountRefView;
  @ApiProperty({ type: String, format: 'date-time' })
  handedAt: Date;

  static from(h: HandoverRead): HandoverView {
    return {
      claimId: h.claimId,
      recipient: accountRef(h.recipient),
      handedBy: accountRef(h.handedBy),
      handedAt: h.createdAt,
    };
  }
}

/** A post as the staff see it at the desk. */
export class StaffPostView extends PostBaseView {
  @ApiProperty({ type: AccountRefView })
  author: AccountRefView;
  @ApiProperty({ enum: NeighbourSide, enumName: 'NeighbourSide' })
  authorSide: NeighbourSide;
  @ApiProperty({ type: PostUnitRefView, nullable: true })
  authorUnit: PostUnitRefView | null;
  @ApiProperty({ type: String, nullable: true })
  closeReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt: Date | null;
  @ApiProperty({ type: Number, description: 'Claims waiting for a decision.' })
  pendingClaims: number;
  @ApiProperty({ type: HandoverView, nullable: true })
  handover: HandoverView | null;

  static from(r: StaffPostRead): StaffPostView {
    return {
      ...PostBaseView.base(r),
      author: accountRef(r.author),
      authorSide: r.post.authorSide,
      authorUnit: r.authorUnit && {
        id: r.authorUnit.id,
        code: r.authorUnit.code,
        building: r.authorUnit.building,
      },
      closeReason: r.post.closeReason,
      closedAt: r.post.closedAt,
      pendingClaims: r.pendingClaims,
      handover: r.handover && HandoverView.from(r.handover),
    };
  }
}

/** The answer to claiming. No note: a stored replay holds no free text. */
export class ClaimCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: NeighbourClaimStatus, enumName: 'NeighbourClaimStatus' })
  status: NeighbourClaimStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(
    c: Pick<NeighbourItemClaim, 'id' | 'status' | 'createdAt'>,
  ): ClaimCreatedView {
    return { id: c.id, status: c.status, createdAt: c.createdAt };
  }
}

class ClaimBaseView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'uuid' })
  postId: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'What the claimant told the staff.',
  })
  note: string | null;
  @ApiProperty({ enum: NeighbourClaimStatus, enumName: 'NeighbourClaimStatus' })
  status: NeighbourClaimStatus;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'A code of `neighbourClaimDecline`, or the system’s `handed_to_another` or `post_closed`.',
  })
  declineReason: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  protected static base(c: NeighbourItemClaim): ClaimBaseView {
    return {
      id: c.id,
      postId: c.postId,
      note: c.note,
      status: c.status,
      declineReason: c.declineReason,
      decidedAt: c.decidedAt,
      createdAt: c.createdAt,
    };
  }
}

/** One of the caller's own claims. */
export class MyClaimView extends ClaimBaseView {
  static from(r: ClaimRead): MyClaimView {
    return ClaimBaseView.base(r.claim);
  }
}

/** A claim as the staff see it: with who made it. */
export class StaffClaimView extends ClaimBaseView {
  @ApiProperty({ type: AccountRefView })
  claimant: AccountRefView;

  static from(r: StaffClaimRead): StaffClaimView {
    return {
      ...ClaimBaseView.base(r.claim),
      claimant: accountRef(r.claimant),
    };
  }
}
