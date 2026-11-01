'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardHeader, Checkbox, ForbiddenState, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { boardWorkFetchers, boardWorkKeys } from '@/lib/board-work';
import { usePermissions } from '@/lib/permissions';

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
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const q = useQuery({ queryKey: boardWorkKeys.rules, queryFn: boardWorkFetchers.rules, enabled: allowed });
  const save = useAction((body: Patch) => unwrap(api.PATCH('/api/v1/staff/governance/rules', { body })), {
    invalidate: [boardWorkKeys.rules],
    onDone: () => toast.show('Saved.'),
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Board rules" />
        <ForbiddenState />
      </>
    );
  const r = q.data;
  return (
    <>
      <PageHeader title="Board rules" description="Checked by the system; the rest of a candidate’s eligibility is yours, by disqualification with a code." />
      <QueryState query={q}>
        {r ? (
          <>
            <Card>
              <CardHeader title="Candidacies" />
              <div className="stack">
                <Checkbox
                  label="Refuse an owner whose units owe past their due date"
                  checked={r.candidacyNoDues}
                  onChange={(e) => save.mutate({ candidacyNoDues: e.target.checked })}
                />
                <Checkbox
                  label="Refuse an owner who also holds an active staff or manager account"
                  checked={r.candidacyNotStaff}
                  onChange={(e) => save.mutate({ candidacyNotStaff: e.target.checked })}
                />
              </div>
            </Card>
            <Card>
              <CardHeader title="The board’s documents" />
              <div className="stack">
                <Checkbox
                  label="Send the board last month’s report on a month’s first days"
                  checked={r.boardReportMonthly}
                  onChange={(e) => save.mutate({ boardReportMonthly: e.target.checked })}
                />
                <p className="t-secondary">{r.reportLogoFileId ? 'A logo heads the board’s documents.' : 'No logo yet.'}</p>
                <FileUpload
                  purpose="compound_logo"
                  label={r.reportLogoFileId ? 'Replace the logo' : 'Add a logo'}
                  onUploaded={(fileId) => save.mutate({ reportLogoFileId: fileId })}
                />
                {r.reportLogoFileId ? (
                  <Button variant="text" onClick={() => save.mutate({ reportLogoFileId: null })}>
                    Take the logo off
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
