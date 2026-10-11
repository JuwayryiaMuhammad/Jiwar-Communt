'use client';

import { unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Checkbox, ConfirmDialog, Dialog, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';

type Occupant = Schema<'UnitOccupantView'>;

/**
 * What changes about how someone occupies a unit, short of ending it
 * (ADR 0012, 0020): a tenant who bought it, and an owner moving in or out.
 */
export function OccupantActions({ unitId, occupant }: { unitId: string; occupant: Occupant }) {
  const toast = useToast();
  const [open, setOpen] = useState<'convert' | 'residence' | null>(null);
  const [resides, setResides] = useState(occupant.resides);
  const name = occupant.account.fullName ?? 'This resident';
  const at = { path: { id: occupant.occupancyId } };
  const refresh = [keys.unit(unitId), keys.unitsReview, keys.residents];
  const close = () => {
    setOpen(null);
    setResides(occupant.resides);
    convert.reset();
    residence.reset();
  };
  const convert = useAction(
    () => unwrap(api.POST('/api/v1/occupancies/{id}/convert-to-owner', { params: at, body: { resides } })),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show(`${name} now owns the unit.`);
        close();
      },
    },
  );
  const residence = useAction(
    () => unwrap(api.POST('/api/v1/occupancies/{id}/residence', { params: at, body: { resides: !occupant.resides } })),
    {
      invalidate: refresh,
      onDone: (o) => {
        toast.show(o.resides ? `${name} lives in the unit.` : `${name} is now a landlord: an owner who lives elsewhere.`);
        close();
      },
    },
  );
  if (occupant.account.erased) return null;

  return (
    <>
      {occupant.occupancyType === 'tenant' ? (
        <Button size="sm" onClick={() => setOpen('convert')}>
          Now owns it
        </Button>
      ) : (
        <Button size="sm" onClick={() => setOpen('residence')}>
          {occupant.resides ? 'Moved out' : 'Moved in'}
        </Button>
      )}
      <Dialog
        open={open === 'convert'}
        onClose={close}
        title={`${name} bought the unit?`}
        description="Their tenant occupancy ends and an owner occupancy starts in its place, keeping the primary role if they had it. They are told, and the owner's decisions open to them."
        onSubmit={() => convert.mutate()}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={convert.isPending}>
              Make owner
            </Button>
          </>
        }
      >
        <div className="form">
          <Checkbox label="They live in the unit" checked={resides} onChange={(e) => setResides(e.target.checked)} />
          <ErrorAlert error={convert.error} />
        </div>
      </Dialog>
      <ConfirmDialog
        open={open === 'residence'}
        onClose={close}
        title={occupant.resides ? `${name} moved out of the unit?` : `${name} moved into the unit?`}
        description={
          occupant.resides
            ? 'They stay the owner, as a landlord: they no longer see the household that lives there. A primary resident must live in the unit, so name another primary first.'
            : 'They become an owner who lives in the unit, and can be named its primary resident.'
        }
        confirmLabel={occupant.resides ? 'Record move out' : 'Record move in'}
        pending={residence.isPending}
        error={<ErrorAlert error={residence.error} />}
        onConfirm={() => residence.mutate()}
      />
    </>
  );
}
