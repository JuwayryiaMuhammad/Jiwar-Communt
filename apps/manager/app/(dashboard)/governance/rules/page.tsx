'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Card, CardHeader, Checkbox, ForbiddenState, PageHeader, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { boardWorkFetchers, boardWorkKeys } from '@/lib/board-work';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/gov-rules';
import en from '@/messages/en/gov-rules';

type Patch = {
  candidacyNoDues?: boolean;
  candidacyNotStaff?: boolean;
  boardReportMonthly?: boolean;
  reportLogoFileId?: string | null;
};

/**
 * The compound's governance rules (ADR 0075): which candidacies the system
 * refuses at nomination, whether the board gets its monthly report, and
 * the logo on the board's documents.
 */
export default function GovernanceRulesPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const q = useQuery({ queryKey: boardWorkKeys.rules, queryFn: boardWorkFetchers.rules, enabled: allowed });
  const save = useAction((body: Patch) => unwrap(api.PATCH('/api/v1/staff/governance/rules', { body })), {
    invalidate: [boardWorkKeys.rules],
    onDone: () => toast.show(c('saved')),
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const r = q.data;
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <QueryState query={q}>
        {r ? (
          <>
            <Card>
              <CardHeader title={t('candidacies')} />
              <div className="stack">
                <Checkbox
                  label={t('noDues')}
                  checked={r.candidacyNoDues}
                  onChange={(e) => save.mutate({ candidacyNoDues: e.target.checked })}
                />
                <Checkbox
                  label={t('notStaff')}
                  checked={r.candidacyNotStaff}
                  onChange={(e) => save.mutate({ candidacyNotStaff: e.target.checked })}
                />
              </div>
            </Card>
            <Card>
              <CardHeader title={t('documents')} />
              <div className="stack">
                <Checkbox
                  label={t('monthly')}
                  checked={r.boardReportMonthly}
                  onChange={(e) => save.mutate({ boardReportMonthly: e.target.checked })}
                />
                <p className="t-secondary">{r.reportLogoFileId ? t('hasLogo') : t('noLogo')}</p>
                <FileUpload
                  purpose="compound_logo"
                  label={r.reportLogoFileId ? t('replaceLogo') : t('addLogo')}
                  onUploaded={(fileId) => save.mutate({ reportLogoFileId: fileId })}
                />
                {r.reportLogoFileId ? (
                  <Button variant="text" onClick={() => save.mutate({ reportLogoFileId: null })}>
                    {t('removeLogo')}
                  </Button>
                ) : null}
              </div>
            </Card>
            <ErrorAlert error={save.error} />
          </>
        ) : null}
      </QueryState>
    </>
  );
}
