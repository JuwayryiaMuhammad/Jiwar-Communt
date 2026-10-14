'use client';

import { QueryState } from '@jiwar/api/react';
import { Badge, Checkbox } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { fetchers, keys } from '@/lib/queries';
import { refKey, type PersonRef } from './logic';

/**
 * The unit's people now — its residing occupants and household members,
 * minors too — to tick whom a membership covers.
 */
export function PeoplePicker({ unitId, value, onChange }: { unitId: string; value: PersonRef[]; onChange: (next: PersonRef[]) => void }) {
  const people = useQuery({ queryKey: keys.clubUnitPeople(unitId), queryFn: () => fetchers.clubUnitPeople(unitId) });
  const picked = new Set(value.map(refKey));
  return (
    <QueryState query={people}>
      <div className="stack stack--sm">
        {(people.data?.data ?? []).length === 0 ? <span className="t-secondary">Nobody lives in this unit now.</span> : null}
        {(people.data?.data ?? []).map((p) => {
          const ref = { kind: p.kind, id: p.id };
          return (
            <span key={refKey(ref)} className="row" style={{ gap: 8 }}>
              <Checkbox
                label={p.fullName ?? 'Erased'}
                checked={picked.has(refKey(ref))}
                onChange={(e) => onChange(e.target.checked ? [...value, ref] : value.filter((x) => refKey(x) !== refKey(ref)))}
              />
              {p.isMinor ? <Badge tone="beige">Minor</Badge> : null}
              <span className="t-secondary">{p.kind === 'occupancy' ? 'Occupant' : 'Household member'}</span>
            </span>
          );
        })}
      </div>
    </QueryState>
  );
}
