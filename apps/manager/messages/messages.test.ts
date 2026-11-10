import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertCatalogs } from '@jiwar/i18n/testing';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Texts that read the same in both languages: only values joined by a sign, or a format's or a term's Latin name. */
const LATIN = [
  'community-announcements.affects.gate',
  'fin-dialogs.invoice.periodRange',
  'gov-board-inbox.range',
  'gov-board-meetings.seat',
  'maint-operations.withReason',
  'maint-queue.col.sla',
  'maint-thread.view.sla',
  'maint-thread.transition',
  'maint-ticket.sla',
  'ops-readiness.days',
  'ops-readiness.summary',
  'ops-readiness.stateDecision',
  'ops-reports.pdf',
  'ops-reports.excel',
  'ops-reports.csv',
  'ops-reports.format.pdf',
  'ops-reports.format.csv',
  'ops-reports.period',
  'ops-tenders.approvalOption',
  'places-permits.detailTitle',
  'services-mgmt-setup.target.both',
  'services-official-letters.pdf',
  'shell-components.schedule',
  'shell-operations.adviceWith',
  'shell-overview.alert.other',
  'units-list.csv',
];

test('every manager catalog carries the same keys in Arabic and English', async () => {
  const { files } = await assertCatalogs(here, { latin: LATIN });
  assert.ok(files > 0);
});
