'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Field,
  ReasonCodeDialog,
  ReasonDialog,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useState } from 'react';
import { ResidentPicker } from '@/components/pickers';
import { api } from '@/lib/api';
import { keys, type UnitDetail } from '@/lib/queries';
import ar from '@/messages/ar/units-states';
import en from '@/messages/en/units-states';
import { REVIEW_LABELS } from './review-labels';

type Flag = Schema<'UnitReviewFlagView'>;
type Open = 'deceased' | 'separation' | 'end-household' | 'transfer' | null;

/** The flags whose catalog entry says what they wait for (`help.<reason>`). */
const HELP_REASONS = ['primary_left', 'primary_frozen', 'primary_deceased', 'separation'] as const;

/**
 * A unit's review flags and the manager's decisions about who holds it
 * (ADR 0021): record a death or a separation, clear a flag by its id, end
 * the household, or move the ownership to another resident.
 */
export function UnitStates({ unit }: { unit: UnitDetail }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const reviewText = useLabel(REVIEW_LABELS);
  const toast = useToast();
  const [open, setOpen] = useState<Open>(null);
  const [clearing, setClearing] = useState<Flag | null>(null);
  const [buyerId, setBuyerId] = useState('');
  const [resides, setResides] = useState(true);
  const path = { path: { id: unit.id } };
  const refresh = [keys.unit(unit.id), keys.unitsReview, keys.residents];
  const flags = unit.reviewFlags ?? [];
  const has = (reason: string) => flags.some((f) => f.reason === reason);


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
    options(t('recordedDeceased')),
  );
  const separation = useAction(
    (reason: Reason) => unwrap(api.POST('/api/v1/units/{id}/separation', { params: path, body: reason })),
    options(t('separationRecorded')),
  );
  const endHousehold = useAction(
    (reason: Reason) => unwrap(api.POST('/api/v1/units/{id}/end-household', { params: path, body: reason })),
    options(t('householdEnded')),
  );
  // A transfer is requested here and approved on the Transfers page, past
  // the dues check (ADR 0083).
  const transfer = useAction(
    (reason: Reason) =>
      unwrap(
        api.POST('/api/v1/staff/units/{unitId}/ownership-transfers', {
          params: { path: { unitId: unit.id } },
          body: { ...reason, toAccountId: buyerId, resides },
        }),
      ),
    {
      invalidate: [...refresh, ['ownership-transfers']],
      onDone: () => {
        toast.show(t('transferRequested'));
        close();
      },
    },
  );
  const clear = useAction(
    (v: { flag: Flag; reasonCode: string }) =>
      unwrap(api.POST('/api/v1/review-flags/{id}/clear', { params: { path: { id: v.flag.id } }, body: { reasonCode: v.reasonCode } })),
    options(t('flagCleared')),
  );

  const occupantIds = new Set((unit.occupants ?? []).map((o) => o.account.id));
  const noteHint = t('noteHint');

  return (
    <>
      {flags.length ? (
        <Card tone="beige">
          <div className="stack">
            <h2 className="t-title-md">{t('underReview')}</h2>
            {flags.map((f) => {
              const help = HELP_REASONS.find((r) => r === f.reason);
              return (
                <div key={f.id} className="stack stack--sm">
                  <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <Badge tone="terracotta">{reviewText(f.reason)}</Badge>
                    <span className="t-secondary">{t('since', { date: fmt.date(f.flaggedAt) })}</span>
                    <span className="spacer" />
                    {help !== 'primary_left' ? (
                      <Button size="sm" onClick={() => setClearing(f)}>
                        {t('clear')}
                      </Button>
                    ) : null}
                  </span>
                  {help ? <p className="t-secondary">{t(`help.${help}`)}</p> : null}
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      <Card flush>
        <CardHeader title={t('whoHolds')} />
        <CardBody>
          <div className="stack stack--sm">
            <p className="t-secondary">{t('whoHoldsHint')}</p>
            <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              {!has('primary_deceased') ? (
                <Button size="sm" onClick={() => setOpen('deceased')}>
                  {t('primaryDied')}
                </Button>
              ) : null}
              {!has('separation') ? (
                <Button size="sm" onClick={() => setOpen('separation')}>
                  {t('separation')}
                </Button>
              ) : null}
              <Button size="sm" onClick={() => setOpen('transfer')}>
                {t('transferOwnership')}
              </Button>
              <Button size="sm" variant="danger" onClick={() => setOpen('end-household')}>
                {t('endHousehold')}
              </Button>
            </span>
          </div>
        </CardBody>
      </Card>

      <ReasonDialog
        open={open === 'deceased'}
        onClose={close}
        title={t('deceasedTitle', { code: unit.code })}
        description={t('deceasedDescription')}
        codes={['deceased', 'other']}
        textLabel={t('noteForRecord')}
        textHint={noteHint}
        confirmLabel={t('record')}
        pending={deceased.isPending}
        error={<ErrorAlert error={deceased.error} />}
        onConfirm={(reason) => deceased.mutate(reason)}
      />
      <ReasonDialog
        open={open === 'separation'}
        onClose={close}
        title={t('separationTitle', { code: unit.code })}
        description={t('separationDescription')}
        codes={['separation', 'other']}
        textLabel={t('noteForRecord')}
        textHint={noteHint}
        confirmLabel={t('record')}
        pending={separation.isPending}
        error={<ErrorAlert error={separation.error} />}
        onConfirm={(reason) => separation.mutate(reason)}
      />
      <ReasonDialog
        open={open === 'end-household'}
        onClose={close}
        title={t('endTitle', { code: unit.code })}
        description={t('endDescription')}
        codes={REASON_CODES.householdEnd}
        confirmLabel={t('endHousehold')}
        danger
        pending={endHousehold.isPending}
        error={<ErrorAlert error={endHousehold.error} />}
        onConfirm={(reason) => endHousehold.mutate(reason)}
      />
      <ReasonDialog
        open={open === 'transfer'}
        onClose={close}
        title={t('transferTitle', { code: unit.code })}
        description={t('transferDescription')}
        codes={REASON_CODES.householdEnd}
        confirmLabel={t('transferConfirm')}
        danger
        pending={transfer.isPending}
        error={
          <div className="stack stack--sm">
            {buyerId === '' ? <Alert tone="info">{t('pickOwnerFirst')}</Alert> : null}
            <ErrorAlert error={transfer.error} />
          </div>
        }
        onConfirm={(reason) => buyerId !== '' && transfer.mutate(reason)}
      >
        <Field label={t('newOwner')} hint={t('newOwnerHint')} error={fieldError(transfer.error, 'toAccountId')}>
          {(p) => (
            <ResidentPicker
              {...p}
              enabled={open === 'transfer'}
              placeholder={t('selectResident')}
              value={buyerId}
              onChange={(id) => setBuyerId(id)}
              decorate={(o) => (occupantIds.has(o.id) ? t('livesHereNow', { name: o.label }) : o.label)}
            />
          )}
        </Field>
        <Checkbox label={t('newOwnerLives')} checked={resides} onChange={(e) => setResides(e.target.checked)} />
      </ReasonDialog>
      <ReasonCodeDialog
        open={clearing !== null}
        onClose={close}
        title={clearing ? t('clearTitle', { reason: reviewText(clearing.reason) }) : ''}
        description={t('clearDescription')}
        codes={REASON_CODES.reviewClear}
        confirmLabel={t('clearConfirm')}
        pending={clear.isPending}
        error={<ErrorAlert error={clear.error} />}
        onConfirm={(reasonCode) => clearing && clear.mutate({ flag: clearing, reasonCode })}
      />
    </>
  );
}
