'use client';

import { Select } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import type { SelectHTMLAttributes } from 'react';
import { fetchers, keys } from '@/lib/queries';

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & { placeholder?: string };

/** The posts a guard works: gates and zones in service, as `gate:<id>` or `zone:<id>`. */
export function PostPicker(props: SelectProps & { gatesOnly?: boolean }) {
  const { placeholder = 'Select a post…', gatesOnly, ...rest } = props;
  const posts = useQuery({ queryKey: keys.securityPosts, queryFn: fetchers.securityPosts });
  return (
    <Select {...rest}>
      <option value="">{posts.isPending ? 'Loading posts…' : placeholder}</option>
      <optgroup label="Gates">
        {(posts.data?.gates ?? []).map((g) => (
          <option key={g.id} value={`gate:${g.id}`}>
            {g.name}
          </option>
        ))}
      </optgroup>
      {gatesOnly ? null : (
        <optgroup label="Zones">
          {(posts.data?.zones ?? []).map((z) => (
            <option key={z.id} value={`zone:${z.id}`}>
              {z.nameEn}
            </option>
          ))}
        </optgroup>
      )}
    </Select>
  );
}

/** The guards the roster may schedule: active `gate.operate` holders. */
export function GuardPicker(props: SelectProps) {
  const { placeholder = 'Select a guard…', ...rest } = props;
  const guards = useQuery({ queryKey: keys.securityGuards, queryFn: fetchers.securityGuards });
  return (
    <Select {...rest}>
      <option value="">{guards.isPending ? 'Loading guards…' : placeholder}</option>
      {(guards.data?.data ?? []).map((g) => (
        <option key={g.id} value={g.id}>
          {g.fullName ?? g.id}
        </option>
      ))}
    </Select>
  );
}
