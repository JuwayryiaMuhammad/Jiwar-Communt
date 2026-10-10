'use client';

import { fieldError, formatDate, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
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

function ContactDialog({ account, onClose }: { account: AccountDetail; onClose: () => void }) {
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
        toast.show('Contact details saved. They sign in with the new ones from now on.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Contact details"
      description="What they sign in with, and where codes and notices are sent. They are told at the old address when it changes."
      onSubmit={() => dirty && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Email" error={fieldError(save.error, 'email')}>
          {(p) => <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field
          label="Phone"
          hint={account.status === 'frozen' && !account.phone ? 'The old number left this account. Enter the new one.' : 'Local Egyptian format, or international with +.'}
          error={fieldError(save.error, 'phone')}
        >
          {(p) => <Input {...p} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />}
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
        toast.show('Account frozen. Every session ended and the phone number is released.');
        setOpen(null);
      },
    },
  );
  const reactivate = useAction(() => unwrap(api.POST('/api/v1/accounts/{id}/reactivate', { params: { path: { id } } })), {
    invalidate: refresh,
    onDone: () => {
      toast.show('Account active again. They can sign in.');
      setOpen(null);
    },
  });

  const erased = a?.erased === true || a?.status === 'erased';
  const name = a?.fullName ?? 'This person';
  const person = a?.type === 'resident' || a?.type === 'family';
  const self = me?.id === id;
  const back = person ? { href: '/residents', label: 'Residents' } : { href: '/staff', label: 'Staff' };

  return (
    <>
      <PageHeader
        back={
          <ButtonLink href={back.href} variant="text" size="sm" icon={<ArrowLeft aria-hidden />}>
            {back.label}
          </ButtonLink>
        }
        title={
          a ? (
            <span className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              {erased ? 'Erased account' : name}
              <StatusBadge status={erased ? 'erased' : a.status} />
            </span>
          ) : (
            'Account'
          )
        }
        description={a && !erased ? `${humanize(a.type)} account${self ? ' · this is you' : ''}` : undefined}
        actions={
          a && !erased && can('accounts.manage') ? (
            <>
              <Button icon={<Pencil aria-hidden />} onClick={() => setOpen('contact')}>
                Contact
              </Button>
              {a.status === 'frozen' ? (
                <Button variant="primary" onClick={() => setOpen('reactivate')}>
                  Reactivate
                </Button>
              ) : !self ? (
                <Button variant="danger" onClick={() => setOpen('freeze')}>
                  Freeze
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
              <p className="t-secondary">
                This account was erased. Its personal data is gone for good; only the record that it existed remains, so past tickets and
                entries still add up.
              </p>
            </Card>
          ) : (
            <div className="grid grid--main-aside">
              <div className="stack">
                {a.status === 'frozen' ? (
                  <Alert tone="warn">
                    This account is frozen: nobody can sign in to it.{' '}
                    {a.phone
                      ? 'Check with the person that it is theirs, then reactivate it.'
                      : 'Its phone number went to someone else, so set a new number under Contact, then reactivate it.'}
                  </Alert>
                ) : null}
                <Card flush>
                  <CardHeader title="Account" />
                  <CardBody>
                    <dl className="dl">
                      <dt>Type</dt>
                      <dd>{humanize(a.type)}</dd>
                      <dt>Phone</dt>
                      <dd>{a.phone ?? <span className="t-secondary">None: released when the account was frozen</span>}</dd>
                      <dt>Email</dt>
                      <dd>{a.email ?? '—'}</dd>
                      <dt>Identity document</dt>
                      <dd>
                        {a.idDocumentType ? humanize(a.idDocumentType) : '—'} {a.idDocumentNumberMasked ?? ''}
                      </dd>
                      <dt>Nationality</dt>
                      <dd>{a.nationality ?? '—'}</dd>
                      <dt>Birth date</dt>
                      <dd>{formatDate(a.birthDate)}</dd>
                      <dt>Created</dt>
                      <dd>{formatDateTime(a.createdAt)}</dd>
                    </dl>
                    {person && can('residents.read') ? (
                      <div style={{ marginTop: 16 }}>
                        <ButtonLink href={`/residents/${a.id}`} size="sm">
                          Units and occupancies
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
        title={`Freeze ${name}'s account?`}
        description="For a phone number that no longer belongs to this person. Every session ends at once, the number is released so its new owner is not mixed up with them, and nobody can sign in until you set a new number and reactivate the account."
        codes={REASON_CODES.accountFreeze}
        textLabel="Note for the record"
        textHint="Kept with the account for management."
        confirmLabel="Freeze account"
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
        title={`Reactivate ${name}'s account?`}
        description="Do this once you have confirmed who holds it and its phone number is theirs. They sign in with a fresh code."
        confirmLabel="Reactivate"
        pending={reactivate.isPending}
        error={<ErrorAlert error={reactivate.error} />}
        onConfirm={() => reactivate.mutate()}
      />
    </>
  );
}
