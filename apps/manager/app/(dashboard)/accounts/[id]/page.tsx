'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Alert,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Dialog,
  Field,
  Input,
  PageHeader,
  ReasonDialog,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Pencil } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AssistPanel } from '@/components/accounts/assist-panel';
import { LegalHolds } from '@/components/accounts/legal-holds';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type AccountDetail } from '@/lib/queries';
import ar from '@/messages/ar/accounts-detail';
import en from '@/messages/en/accounts-detail';

function ContactDialog({ account, onClose }: { account: AccountDetail; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [email, setEmail] = useState(account.email ?? '');
  const [phone, setPhone] = useState(account.phone ?? '');
  // Only what changed: an unchanged phone is not sent, so it is not re-checked.
  const changes = {
    ...(email.trim() !== (account.email ?? '') ? { email: email.trim() } : {}),
    ...(phone.trim() !== (account.phone ?? '') ? { phone: phone.trim() } : {}),
  };
  const dirty = Object.keys(changes).length > 0;
  const save = useAction(
    () => unwrap(api.PATCH('/api/v1/accounts/{id}/contact', { params: { path: { id: account.id } }, body: changes })),
    {
      invalidate: [keys.account(account.id), keys.accounts, keys.residents],
      onDone: () => {
        toast.show(t('contact.saved'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('contact.title')}
      description={t('contact.description')}
      onSubmit={() => dirty && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
            {c('save')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={c('email')} error={fieldError(save.error, 'email')}>
          {(p) => <Input {...p} className="ltr" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field
          label={c('phone')}
          hint={account.status === 'frozen' && !account.phone ? t('contact.phoneNew') : t('contact.phoneHint')}
          error={fieldError(save.error, 'phone')}
        >
          {(p) => <Input {...p} className="ltr" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

type Open = 'contact' | 'freeze' | 'reactivate' | null;

/**
 * One account of the compound (ADR 0023, 0036): who they are, how they are
 * reached, freezing and recovering it, legal holds, and acting for a
 * resident who does not use the app. Each part shows only to a role that
 * holds its permission.
 */
export default function AccountPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { me, can } = usePermissions();
  const [open, setOpen] = useState<Open>(null);
  const account = useQuery({ queryKey: keys.account(id), queryFn: () => fetchers.account(id) });
  const a = account.data;
  const refresh = [keys.account(id), keys.accounts, keys.residents];

  const freeze = useAction(
    (reason: { reasonCode: string; reason: string }) =>
      unwrap(api.POST('/api/v1/accounts/{id}/freeze', { params: { path: { id } }, body: reason })),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show(t('freeze.done'));
        setOpen(null);
      },
    },
  );
  const reactivate = useAction(() => unwrap(api.POST('/api/v1/accounts/{id}/reactivate', { params: { path: { id } } })), {
    invalidate: refresh,
    onDone: () => {
      toast.show(t('reactivate.done'));
      setOpen(null);
    },
  });

  const erased = a?.erased === true || a?.status === 'erased';
  const name = a?.fullName ?? t('thisPerson');
  const person = a?.type === 'resident' || a?.type === 'family';
  const self = me?.id === id;
  const back = person ? { href: '/residents', label: t('residents') } : { href: '/staff', label: t('staff') };

  return (
    <>
      <PageHeader
        back={
          <ButtonLink href={back.href} variant="text" size="sm" icon={<ArrowLeft aria-hidden className="icon-dir" />}>
            {back.label}
          </ButtonLink>
        }
        title={
          a ? (
            <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {erased ? t('erasedAccount') : name}
              <StatusBadge status={erased ? 'erased' : a.status} />
            </span>
          ) : (
            t('account')
          )
        }
        description={
          a && !erased ? [t('typeAccount', { type: label(a.type) }), ...(self ? [t('thisIsYou')] : [])].join(' · ') : undefined
        }
        actions={
          a && !erased && can('accounts.manage') ? (
            <>
              <Button icon={<Pencil aria-hidden />} onClick={() => setOpen('contact')}>
                {t('contact')}
              </Button>
              {a.status === 'frozen' ? (
                <Button variant="primary" onClick={() => setOpen('reactivate')}>
                  {t('reactivate')}
                </Button>
              ) : !self ? (
                <Button variant="danger" onClick={() => setOpen('freeze')}>
                  {t('freeze')}
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />
      <QueryState query={account}>
        {a ? (
          erased ? (
            <Card>
              <p className="t-secondary">{t('erasedBody')}</p>
            </Card>
          ) : (
            <div className="grid grid--main-aside">
              <div className="stack">
                {a.status === 'frozen' ? (
                  <Alert tone="warn">
                    {t('frozenNobody')} {a.phone ? t('frozenCheck') : t('frozenNoPhone')}
                  </Alert>
                ) : null}
                <Card flush>
                  <CardHeader title={t('account')} />
                  <CardBody>
                    <dl className="dl">
                      <dt>{c('type')}</dt>
                      <dd>{label(a.type)}</dd>
                      <dt>{c('phone')}</dt>
                      <dd>{a.phone ? <span className="ltr">{a.phone}</span> : <span className="t-secondary">{t('phoneReleased')}</span>}</dd>
                      <dt>{c('email')}</dt>
                      <dd className="ltr">{a.email ?? '—'}</dd>
                      <dt>{t('identityDocument')}</dt>
                      <dd>
                        {a.idDocumentType ? label(a.idDocumentType) : '—'} <span className="ltr">{a.idDocumentNumberMasked ?? ''}</span>
                      </dd>
                      <dt>{t('nationality')}</dt>
                      <dd>{a.nationality ?? '—'}</dd>
                      <dt>{t('birthDate')}</dt>
                      <dd>{f.day(a.birthDate)}</dd>
                      <dt>{c('created')}</dt>
                      <dd>{f.dateTime(a.createdAt)}</dd>
                    </dl>
                    {person && can('residents.read') ? (
                      <div style={{ marginTop: 16 }}>
                        <ButtonLink href={`/residents/${a.id}`} size="sm">
                          {t('unitsLink')}
                        </ButtonLink>
                      </div>
                    ) : null}
                  </CardBody>
                </Card>
                {person && can('residents.assist') ? <AssistPanel accountId={a.id} name={name} /> : null}
              </div>
              <div className="stack">{can('accounts.legal_hold') ? <LegalHolds accountId={a.id} /> : null}</div>
            </div>
          )
        ) : null}
      </QueryState>

      {a && open === 'contact' ? <ContactDialog account={a} onClose={() => setOpen(null)} /> : null}
      <ReasonDialog
        open={open === 'freeze'}
        onClose={() => {
          setOpen(null);
          freeze.reset();
        }}
        title={t('freeze.title', { name })}
        description={t('freeze.description')}
        codes={REASON_CODES.accountFreeze}
        textLabel={t('freeze.note')}
        textHint={t('freeze.noteHint')}
        confirmLabel={t('freeze.confirm')}
        danger
        pending={freeze.isPending}
        error={<ErrorAlert error={freeze.error} />}
        onConfirm={(reason) => freeze.mutate(reason)}
      />
      <ConfirmDialog
        open={open === 'reactivate'}
        onClose={() => {
          setOpen(null);
          reactivate.reset();
        }}
        title={t('reactivate.title', { name })}
        description={t('reactivate.description')}
        confirmLabel={t('reactivate')}
        pending={reactivate.isPending}
        error={<ErrorAlert error={reactivate.error} />}
        onConfirm={() => reactivate.mutate()}
      />
    </>
  );
}
