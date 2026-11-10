'use client';

import type { ReactNode } from 'react';
import { EmptyState, SkeletonRows } from './feedback';
import { useCommonT } from './i18n';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  width?: number | string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  empty,
  emptyHint,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  rowKey: (row: T) => string;
  loading?: boolean;
  empty?: string;
  emptyHint?: ReactNode;
}) {
  const t = useCommonT();
  if (loading && !rows?.length) return <SkeletonRows cols={Math.min(columns.length, 5)} />;
  if (!rows?.length) return <EmptyState title={empty ?? t('state.empty')}>{emptyHint}</EmptyState>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={c.width ? { width: c.width } : undefined} className={c.className}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => (
                <td key={c.key} className={c.className}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
