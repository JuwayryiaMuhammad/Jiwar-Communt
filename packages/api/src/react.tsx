'use client';

import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { Alert, Button, ForbiddenState, SkeletonRows } from '@jiwar/ui';
import type { ReactNode } from 'react';
import { ApiError, errorText, fieldText } from './errors';

export { fieldError } from './errors';
export * from './person-fields';

export interface Page<T> {
  data: T[];
  nextCursor?: string | null;
}

/** A cursor-paged list (`?cursor=&limit=`) shown with a "Load more" button. */
export function useCursorList<T>(
  key: QueryKey,
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  options: { enabled?: boolean; refetchInterval?: number } = {},
) {
  const query = useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: options.enabled,
    refetchInterval: options.refetchInterval,
  });
  const rows = query.data?.pages.flatMap((p) => p.data);
  return { ...query, rows };
}

export function LoadMore({
  query,
}: {
  query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown };
}) {
  if (!query.hasNextPage) return null;
  return (
    <div className="card__footer">
      <Button size="sm" loading={query.isFetchingNextPage} onClick={() => query.fetchNextPage()}>
        Load more
      </Button>
    </div>
  );
}

/** Loading skeleton, "no access" for 403, an error line otherwise. */
export function QueryState({
  query,
  children,
  rows,
}: {
  query: { isPending: boolean; error: unknown };
  children: ReactNode;
  rows?: number;
}) {
  if (query.error) {
    if (query.error instanceof ApiError && query.error.status === 403) return <ForbiddenState />;
    return (
      <div style={{ padding: 16 }}>
        <Alert tone="error">{errorText(query.error)}</Alert>
      </div>
    );
  }
  if (query.isPending) return <SkeletonRows rows={rows} />;
  return <>{children}</>;
}

export function ErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const fields = error instanceof ApiError ? error.fields : [];
  return (
    <Alert tone="error">
      {errorText(error)}
      {fields.length ? (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {fields.map((f) => (
            <li key={f.field + f.code}>
              <strong>{f.field}</strong>: {fieldText(f.code, f.params)}
            </li>
          ))}
        </ul>
      ) : null}
    </Alert>
  );
}

/**
 * A mutation that invalidates the given query keys on success and reports
 * through `onDone`. Errors stay on the mutation for the form to render.
 */
export function useAction<V, R>(
  fn: (vars: V) => Promise<R>,
  options: { invalidate?: QueryKey[]; onDone?: (result: R, vars: V) => void } = {},
) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result, vars) => {
      await Promise.all((options.invalidate ?? []).map((key) => client.invalidateQueries({ queryKey: key })));
      options.onDone?.(result, vars);
    },
  });
}
