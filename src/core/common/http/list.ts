import type { Type } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { Type as TransformType } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import type { Page } from '../cursor';
import { withParams } from '../validation/validation-errors';

/** Every list in the API has this shape (API v0, ADR 0025). */
export interface ListResponse<T> {
  data: T[];
  /** Opaque; pass back as `cursor`. Null on the last page, and always null on a bounded collection. */
  nextCursor: string | null;
}

export const HTTP_DEFAULT_LIMIT = 20;
const LIMIT = { min: 1, max: 100 };

/**
 * `?cursor=&limit=` on every paged list. Filters extend this class, so an
 * unknown query parameter is FIELD_NOT_ALLOWED like an unknown body field.
 */
export class PageQueryDto {
  @ApiProperty({
    required: false,
    type: String,
    description: 'Opaque cursor from the previous page (`nextCursor`).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 512, withParams({ min: 1, max: 512 }))
  cursor?: string;

  @ApiProperty({
    required: false,
    type: Number,
    minimum: LIMIT.min,
    maximum: LIMIT.max,
    default: HTTP_DEFAULT_LIMIT,
  })
  @IsOptional()
  @TransformType(() => Number)
  @IsInt(withParams(LIMIT))
  @Min(LIMIT.min, withParams(LIMIT))
  @Max(LIMIT.max, withParams(LIMIT))
  limit: number = HTTP_DEFAULT_LIMIT;
}

/** A service page as the API's list shape, each item through its view. */
export function toList<S, T>(
  page: Page<S>,
  view: (item: S) => T,
): ListResponse<T> {
  return { data: page.items.map(view), nextCursor: page.nextCursor };
}

/**
 * A bounded collection (per unit or per account, capped by domain rules, or
 * a code catalog): the same shape, never a next page.
 */
export function bounded<S, T>(
  items: readonly S[],
  view: (item: S) => T,
): ListResponse<T> {
  return { data: items.map(view), nextCursor: null };
}

const listTypes = new Map<Type<unknown>, Type<unknown>>();

/** The Swagger model of `{ data: Item[], nextCursor }`, one per item view. */
export function ListOf<T>(item: Type<T>): Type<ListResponse<T>> {
  const known = listTypes.get(item);
  if (known) return known as Type<ListResponse<T>>;
  class List {
    @ApiProperty({ type: [item] })
    data: T[];

    @ApiProperty({ type: String, nullable: true })
    nextCursor: string | null;
  }
  Object.defineProperty(List, 'name', { value: `${item.name}List` });
  listTypes.set(item, List);
  return List;
}
