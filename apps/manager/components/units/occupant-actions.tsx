'use client';

import { unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Checkbox, ConfirmDialog, Dialog, useCommonT, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import ar from '@/messages/ar/units-household';
import en from '@/messages/en/units-household';

type Occupant = Schema<'UnitOccupantView'>;

/**
 * What changes about how someone occupies a unit, short of ending it
 * (ADR 0012, 0020): a tenant who bought it, and an owner moving in or out.
 */
export function OccupantActions({ unitId, occupant }: { unitId: string; occupant: Occupant }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [open, setOpen] = useState<'convert' | 'residence' | null>(null);
  const [resides, setResides] = useState(occupant.resides);
  const name = occupant.account.fullName ?? t('thisResident');
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
        toast.show(t('nowOwnsToast', { name }));
        close();
      },
    },
  );
  const residence = useAction(
    () => unwrap(api.POST('/api/v1/occupancies/{id}/residence', { params: at, body: { resides: !occupant.resides } })),
    {
      invalidate: refresh,
      onDone: (o) => {
        toast.show(o.resides ? t('livesInToast', { name }) : t('landlordToast', { name }));
        close();
      },
    },
  );
  if (occupant.account.erased) return null;

  return (
    <>
      {occupant.occupancyType === 'tenant' ? (
        <Button size="sm" onClick={() => setOpen('convert')}>
          {t('nowOwns')}
        </Button>
      ) : (
        <Button size="sm" onClick={() => setOpen('residence')}>
          {occupant.resides ? t('movedOut') : t('movedIn')}
        </Button>
      )}
      <Dialog
        open={open === 'convert'}
        onClose={close}
        title={t('convertTitle', { name })}
        description={t('convertDescription')}
        onSubmit={() => convert.mutate()}
        footer={
          <>
            <Button onClick={close}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={convert.isPending}>
              {t('makeOwner')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Checkbox label={t('livesThere')} checked={resides} onChange={(e) => setResides(e.target.checked)} />
          <ErrorAlert error={convert.error} />
        </div>
      </Dialog>
      <ConfirmDialog
        open={open === 'residence'}
        onClose={close}
        title={occupant.resides ? t('moveOutTitle', { name }) : t('moveInTitle', { name })}
        description={occupant.resides ? t('moveOutDescription') : t('moveInDescription')}
        confirmLabel={occupant.resides ? t('recordMoveOut') : t('recordMoveIn')}
        pending={residence.isPending}
        error={<ErrorAlert error={residence.error} />}
        onConfirm={() => residence.mutate()}
      />
    </>
  );
}
