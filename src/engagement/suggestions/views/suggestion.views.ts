import { ApiProperty } from '@nestjs/swagger';
import {
  SuggestionStatus,
  type Suggestion,
  type SuggestionTopic,
  type SuggestionUpdate,
} from '@prisma/client';
import { CommunityAttachmentView } from '../../content/attachment.view';
import type { SuggestionRead } from '../suggestions.service';

export class SuggestionCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  /** No text: the stored replay of a create holds none. */
  static from(s: Pick<Suggestion, 'id' | 'createdAt'>): SuggestionCreatedView {
    return { id: s.id, createdAt: s.createdAt };
  }
}

export class SuggestionTopicRefView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String })
  key: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameAr: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  nameEn: string;

  static from(t: SuggestionTopic): SuggestionTopicRefView {
    return { id: t.id, key: t.key, nameAr: t.nameAr, nameEn: t.nameEn };
  }
}

/** How a published suggestion is shown: the staff's summary of it. */
export class PublicSummaryView {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Written by the staff.',
  })
  titleEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  textEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  titleAr: string | null;
  @ApiProperty({ type: String, nullable: true })
  textAr: string | null;

  static from(s: Suggestion): PublicSummaryView | null {
    return s.publishedAt
      ? {
          titleEn: s.publicTitleEn,
          textEn: s.publicTextEn,
          titleAr: s.publicTitleAr,
          textAr: s.publicTextAr,
        }
      : null;
  }
}

/** What was done about a suggestion, in the staff's words. */
export class DoneNoteView {
  @ApiProperty({ type: String, format: 'date-time' })
  doneAt: Date;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Written by the staff.',
  })
  noteEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  noteAr: string | null;
  @ApiProperty({ type: Number })
  photoCount: number;
  @ApiProperty({
    type: [CommunityAttachmentView],
    description: 'Empty where the list does not carry them.',
  })
  photos: CommunityAttachmentView[];

  static from(r: SuggestionRead): DoneNoteView | null {
    const s = r.suggestion;
    return s.doneAt
      ? {
          doneAt: s.doneAt,
          noteEn: s.doneNoteEn,
          noteAr: s.doneNoteAr,
          photoCount: s.doneAttachmentIds.length,
          photos: (r.photos ?? []).map((p) => CommunityAttachmentView.from(p)),
        }
      : null;
  }
}

/** A move or an answer, as the author reads it: no staff member is named. */
export class SuggestionUpdateView {
  @ApiProperty({ enum: SuggestionStatus, enumName: 'SuggestionStatus' })
  status: SuggestionStatus;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'What the staff answered then, if they did.',
  })
  response: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  at: Date;

  static from(u: SuggestionUpdate): SuggestionUpdateView {
    return { status: u.status, response: u.response, at: u.createdAt };
  }
}

/** One of the caller's own suggestions. */
export class MySuggestionListItemView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: SuggestionTopicRefView })
  topic: SuggestionTopicRefView;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  unitId: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The caller’s own words.',
  })
  body: string | null;
  @ApiProperty({ enum: SuggestionStatus, enumName: 'SuggestionStatus' })
  status: SuggestionStatus;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The staff’s answer, as it stands now.',
  })
  response: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  respondedAt: Date | null;
  @ApiProperty({
    type: PublicSummaryView,
    nullable: true,
    description:
      'How it is shown on the board, when the staff put it there; never with the caller’s name or words. Null: it is not on the board.',
  })
  publicSummary: PublicSummaryView | null;
  @ApiProperty({
    type: Number,
    description: 'Accounts that support it on the board.',
  })
  supports: number;
  @ApiProperty({ type: DoneNoteView, nullable: true })
  done: DoneNoteView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: SuggestionRead): MySuggestionListItemView {
    const s = r.suggestion;
    return {
      id: s.id,
      topic: SuggestionTopicRefView.from(r.topic),
      unitId: s.unitId,
      body: s.body,
      status: s.status,
      response: s.response,
      respondedAt: s.respondedAt,
      publicSummary: PublicSummaryView.from(s),
      supports: s.publishedAt ? r.supports : 0,
      done: DoneNoteView.from(r),
      createdAt: s.createdAt,
    };
  }
}

export class MySuggestionView extends MySuggestionListItemView {
  @ApiProperty({
    type: [SuggestionUpdateView],
    description: 'Each move and each answer, the oldest first.',
  })
  updates: SuggestionUpdateView[];

  static from(r: SuggestionRead): MySuggestionView {
    return {
      ...MySuggestionListItemView.from(r),
      updates: (r.updates ?? []).map((u) => SuggestionUpdateView.from(u)),
    };
  }
}

/**
 * A suggestion on the public board: the staff's summary and how many
 * support it. Never the author, their unit or their words.
 */
export class BoardSuggestionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: SuggestionTopicRefView })
  topic: SuggestionTopicRefView;
  @ApiProperty({ type: PublicSummaryView })
  summary: PublicSummaryView;
  @ApiProperty({ enum: SuggestionStatus, enumName: 'SuggestionStatus' })
  status: SuggestionStatus;
  @ApiProperty({ type: String, format: 'date-time' })
  publishedAt: Date;
  @ApiProperty({ type: Number })
  supports: number;
  @ApiProperty({ type: Boolean, description: 'The caller supports it.' })
  supported: boolean;
  @ApiProperty({ type: DoneNoteView, nullable: true })
  done: DoneNoteView | null;

  static from(r: SuggestionRead): BoardSuggestionView {
    const s = r.suggestion;
    return {
      id: s.id,
      topic: SuggestionTopicRefView.from(r.topic),
      summary: PublicSummaryView.from(s)!,
      status: s.status,
      publishedAt: s.publishedAt!,
      supports: r.supports,
      supported: r.supported === true,
      done: DoneNoteView.from(r),
    };
  }
}

/** "You said, we did": a done suggestion and what was done. */
export class DoneSuggestionView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: SuggestionTopicRefView })
  topic: SuggestionTopicRefView;
  @ApiProperty({
    type: PublicSummaryView,
    nullable: true,
    description: 'The staff’s summary, when the suggestion is on the board.',
  })
  summary: PublicSummaryView | null;
  @ApiProperty({ type: DoneNoteView })
  done: DoneNoteView;
  @ApiProperty({ type: Number })
  supports: number;

  static from(r: SuggestionRead): DoneSuggestionView {
    return {
      id: r.suggestion.id,
      topic: SuggestionTopicRefView.from(r.topic),
      summary: PublicSummaryView.from(r.suggestion),
      done: DoneNoteView.from(r)!,
      supports: r.suggestion.publishedAt ? r.supports : 0,
    };
  }
}

export class SuggestionAuthorView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
}

/** A move or an answer, as the staff read it: with who made it. */
export class StaffSuggestionUpdateView extends SuggestionUpdateView {
  @ApiProperty({ type: String, format: 'uuid' })
  byId: string;

  static from(u: SuggestionUpdate): StaffSuggestionUpdateView {
    return { ...SuggestionUpdateView.from(u), byId: u.byId };
  }
}

/** A suggestion as the staff who handle them see it. */
export class StaffSuggestionListItemView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: SuggestionTopicRefView })
  topic: SuggestionTopicRefView;
  @ApiProperty({ type: SuggestionAuthorView })
  author: SuggestionAuthorView;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  unitId: string | null;
  @ApiProperty({ type: String, nullable: true })
  unitCode: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The resident’s words. Null once their account was erased.',
  })
  body: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'The author’s account was erased.',
  })
  erased: boolean;
  @ApiProperty({ enum: SuggestionStatus, enumName: 'SuggestionStatus' })
  status: SuggestionStatus;
  @ApiProperty({ type: String, nullable: true })
  response: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  respondedAt: Date | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  publishedAt: Date | null;
  @ApiProperty({ type: PublicSummaryView, nullable: true })
  publicSummary: PublicSummaryView | null;
  @ApiProperty({ type: Number })
  supports: number;
  @ApiProperty({ type: DoneNoteView, nullable: true })
  done: DoneNoteView | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: SuggestionRead): StaffSuggestionListItemView {
    const s = r.suggestion;
    return {
      id: s.id,
      topic: SuggestionTopicRefView.from(r.topic),
      author: r.author ?? { id: s.authorId, fullName: null },
      unitId: s.unitId,
      unitCode: r.unitCode,
      body: s.body,
      erased: s.erasedAt !== null,
      status: s.status,
      response: s.response,
      respondedAt: s.respondedAt,
      publishedAt: s.publishedAt,
      publicSummary: PublicSummaryView.from(s),
      supports: r.supports,
      done: DoneNoteView.from(r),
      createdAt: s.createdAt,
    };
  }
}

export class StaffSuggestionView extends StaffSuggestionListItemView {
  @ApiProperty({ type: [StaffSuggestionUpdateView] })
  updates: StaffSuggestionUpdateView[];

  static from(r: SuggestionRead): StaffSuggestionView {
    return {
      ...StaffSuggestionListItemView.from(r),
      updates: (r.updates ?? []).map((u) => StaffSuggestionUpdateView.from(u)),
    };
  }
}
