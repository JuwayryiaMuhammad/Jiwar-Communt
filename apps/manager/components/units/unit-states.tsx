'use client';

import { fieldError, formatDate, humanize, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Checkbox, Field, ReasonCodeDialog, ReasonDialog, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { REVIEW_TEXT } from '@/lib/labels';
import { fetchers, keys, type UnitDetail } from '@/lib/queries';

type Flag = Schema<'UnitReviewFlagView'>;
type Open = 'deceased' | 'separation' | 'end-household' | 'transfer' | null;

/** What each open flag waits for, and whether it can be cleared by hand. */
const FLAG_HELP: Record<string, { text: string; clearable: boolean }> = {
  primary_left: {
    text: 'The primary resident left. Name a new primary among the occupants if the family stays, or end the household. It cannot be cleared by hand.',
    clearable: false,
  },
  primary_frozen: { text: "The primary resident's account is frozen. It clears when the account is reactivated or a new primary is named.", clearable: true },
  primary_deceased: {
    text: 'Household grants and revocations are frozen and payments stopped; tickets, visitors and emergency continue. Name a new primary, or clear the flag if it was recorded by mistake.',
    clearable: true,
  },
  separation: {
    text: "Removing an adult or revoking an adult's access is your decision now, from the household table. Clear the flag once it is settled.",
    clearable: true,
  },
};

/**
 * A unit's review flags and the manager's decisions about who holds it
 * (ADR 0021): record a death or a separation, clear a flag by its id, end
 * the household, or move the ownership to another resident.
 */
export function UnitStates({ unit }: { unit: UnitDetail }) {
  const toast = useToast();
  const [open, setOpen] = useState<Open>(null);
  const [clearing, setClearing] = useState<Flag | null>(null);
  const [buyerId, setBuyerId] = useState('');
  const [resides, setResides] = useState(true);
  const path = { path: { id: unit.id } };
  const refresh = [keys.unit(unit.id), keys.unitsReview, keys.residents];
  const flags = unit.reviewFlags ?? [];
  const has = (reason: string) => flags.some((f) => f.reason === reason);

  const residents = useQuery({
    queryKey: [...keys.residents, 'picker'],
    queryFn: () => fetchers.residents(undefined, 100),
    enabled: open === 'transfer',
  });

  const close = () => {
    setOpen(null);
    setClearing(null);
    setBuyerId('');
    setResides(true);
    for (const a of [deceased, separation, endHousehold, transfer, clear]) a.reset();
  };
  const options = (text: string) => ({
    invalidate: refresh,
    onDone: () => {
      toast.show(text);
      close();
    },
  });
  type Reason = { reasonCode: string; reason: string };
  const deceased = useAction(
    (reason: Reason) => unwrap(api.POST('/api/v1/units/{id}/deceased', { params: path, body: reason })),
    options('Recorded. The household is under review and the adults are told so, never why.'),
  );
  const separation = useAction(
    (reason: Reason) => unwrap(api.POST('/api/v1/units/{id}/separation', { params: path, body: reason })),
    options('Separation recorded. Removing an adult is now your decision.'),
  );
  const endHousehold = useAction(
    (reason: Reason) => unwrap(api.POST('/api/v1/units/{id}/end-household', { params: path, body: reason })),
    options('Household ended. Its members, delegations and worker engagements have ended.'),
  );
  const transfer = useAction(
    (reason: Reason) =>
      unwrap(api.POST('/api/v1/units/{id}/transfer-ownership', { params: path, body: { ...reason, toAccountId: buyerId, resides } })),
    options('Ownership transferred. The previous occupancies, household and worker engagements have ended.'),
  );
  const clear = useAction(
    (v: { flag: Flag; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/review-flags/{id}/clear', { params: { path: { id: v.flag.id } }, body: { reasonCode: v.reasonCode } })),
    options('Review flag cleared.'),
  );

  const occupantIds = new Set((unit.occupants ?? []).map((o) => o.account.id));
  const buyers = (residents.data?.data ?? []).filter((r) => !r.erased);
  const noteHint = 'Kept with the flag for management. Never shown to the household and never in the audit trail.';

  return (
    <>
      {flags.length ? (
        <Card tone="beige">
          <div className="stack">
            <h2 className="t-title-md">Under review</h2>
            {flags.map((f) => (
              <div key={f.id} className="stack stack--sm">
                <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <Badge tone="terracotta">{REVIEW_TEXT[f.reason] ?? humanize(f.reason)}</Badge>
                  <span className="t-secondary">since {formatDate(f.flaggedAt)}</span>
                  <span className="spacer" />
                  {FLAG_HELP[f.reason]?.clearable !== false ? (
                    <Button size="sm" onClick={() => setClearing(f)}>
                      Clear
                    </Button>
                  ) : null}
                </span>
                <p className="t-secondary">{FLAG_HELP[f.reason]?.text}</p>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <Card flush>
        <CardHeader title="Who holds the unit" />
        <CardBody>
          <div className="stack stack--sm">
            <p className="t-secondary">For when something changed that the residents cannot settle themselves.</p>
            <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {!has('primary_deceased') ? (
                <Button size="sm" onClick={() => setOpen('deceased')}>
                  Primary has died
                </Button>
              ) : null}
              {!has('separation') ? (
                <Button size="sm" onClick={() => setOpen('separation')}>
                  Separation
                </Button>
              ) : null}
              <Button size="sm" onClick={() => setOpen('transfer')}>
                Transfer ownership
              </Button>
              <Button size="sm" variant="danger" onClick={() => setOpen('end-household')}>
                End household
              </Button>
            </span>
          </div>
        </CardBody>
      </Card>

      <ReasonDialog
        open={open === 'deceased'}
        onClose={close}
        title={`Record that unit ${unit.code}'s primary resident has died?`}
        description="Nothing is closed or revoked. The household's permissions freeze and payments stop until a new primary is named; tickets, visitors and emergency continue. The adults are told the unit is under review, never why."
        codes={['deceased', 'other']}
        textLabel="Note for the record"
        textHint={noteHint}
        confirmLabel="Record"
        pending={deceased.isPending}
        error={<ErrorAlert error={deceased.error} />}
        onConfirm={(reason) => deceased.mutate(reason)}
      />
      <ReasonDialog
        open={open === 'separation'}
        onClose={close}
        title={`Record a separation in unit ${unit.code}?`}
        description="Removing an adult or revoking an adult's access becomes your decision, and the household's shared activity view stops. Entry, tickets, emergency and visitor notices continue for everyone. The adults are told."
        codes={['separation', 'other']}
        textLabel="Note for the record"
        textHint={noteHint}
        confirmLabel="Record"
        pending={separation.isPending}
        error={<ErrorAlert error={separation.error} />}
        onConfirm={(reason) => separation.mutate(reason)}
      />
      <ReasonDialog
        open={open === 'end-household'}
        onClose={close}
        title={`End the household of unit ${unit.code}?`}
        description="Every membership, pending invite, delegation and domestic worker engagement of the unit ends, and each person is told. The occupancies stay: end those separately if the occupants left. This cannot be undone; a new household starts from invitations."
        codes={REASON_CODES.householdEnd}
        confirmLabel="End household"
        danger
        pending={endHousehold.isPending}
        error={<ErrorAlert error={endHousehold.error} />}
        onConfirm={(reason) => endHousehold.mutate(reason)}
      />
      <ReasonDialog
        open={open === 'transfer'}
        onClose={close}
        title={`Transfer the ownership of unit ${unit.code}?`}
        description="Every current occupancy of the unit ends and the household ends with it, including every domestic worker engagement of the household; each person is told. The new owner's occupancy starts now and must register their own workers. The previous family keeps no access. This cannot be undone."
        codes={REASON_CODES.householdEnd}
        confirmLabel="Transfer ownership"
        danger
        pending={transfer.isPending}
        error={
          <div className="stack stack--sm">
            {buyerId === '' ? <Alert tone="info">Pick the new owner first.</Alert> : null}
            <ErrorAlert error={transfer.error} />
          </div>
        }
        onConfirm={(reason) => buyerId !== '' && transfer.mutate(reason)}
      >
        <Field
          label="New owner"
          hint="A resident of the compound (the first 100). Add them on the Residents page first if they are new."
          error={fieldError(transfer.error, 'toAccountId')}
        >
          {(p) => (
            <Select {...p} value={buyerId} onChange={(e) => setBuyerId(e.target.value)}>
              <option value="">Select a resident…</option>
              {buyers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName ?? 'Resident'}
                  {occupantIds.has(r.id) ? ' (lives here now)' : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Checkbox label="The new owner will live in the unit (they become its primary resident)" checked={resides} onChange={(e) => setResides(e.target.checked)} />
      </ReasonDialog>
      <ReasonCodeDialog
        open={clearing !== null}
        onClose={close}
        title={clearing ? `Clear "${REVIEW_TEXT[clearing.reason] ?? humanize(clearing.reason)}"?` : ''}
        description="The household works normally again where this flag held it back."
        codes={REASON_CODES.reviewClear}
        confirmLabel="Clear flag"
        pending={clear.isPending}
        error={<ErrorAlert error={clear.error} />}
        onConfirm={(reasonCode) => clearing && clear.mutate({ flag: clearing, reasonCode })}
      />
    </>
  );
}
