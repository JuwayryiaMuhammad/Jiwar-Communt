import { changePercent, flatten, lineUp } from './report-compare';
import type { ReportColumn } from './report-registry';

const columns: ReportColumn[] = [
  { key: 'building', en: 'Building', ar: 'المبنى', kind: 'text' },
  { key: 'tickets', en: 'Tickets', ar: 'البلاغات', kind: 'number', sum: true },
  { key: 'spend', en: 'Spend', ar: 'الإنفاق', kind: 'money', sum: true },
  { key: 'share', en: 'Share', ar: 'النسبة', kind: 'number' },
];

describe('report comparison (ADR 0086)', () => {
  it('lines rows up by their dimensions; a summed figure missing is 0, a share null', () => {
    const { rows, totals } = lineUp(
      columns,
      1,
      { rows: [['A', '3', '150.00', '0.6']] },
      { rows: [['B', '1', '20.50', '1']] },
      null,
    );
    expect(rows).toEqual([
      {
        values: ['A', '3', '150.00', '0.6'],
        previous: ['A', '0', '0', null],
        lastYear: null,
      },
      {
        values: ['B', '0', '0', null],
        previous: ['B', '1', '20.50', '1'],
        lastYear: null,
      },
    ]);
    expect(totals.values).toEqual(['Total', '3', '150.00', null]);
    expect(totals.previous).toEqual(['Total', '1', '20.50', null]);
    expect(totals.lastYear).toBeNull();
  });

  it('a change in percent, none from nothing', () => {
    expect(changePercent('150', '100')).toBe('50.0');
    expect(changePercent('50', '200')).toBe('-75.0');
    expect(changePercent('5', '0')).toBeNull();
    expect(changePercent(null, '1')).toBeNull();
  });

  it('flattens: each figure, then the period before and its change, then the totals', () => {
    const lined = lineUp(
      columns,
      1,
      { rows: [['A', '3', '150.00', '0.6']] },
      { rows: [['A', '2', '100.00', '0.5']] },
      null,
    );
    const sheet = flatten({
      key: 'maintenance_spend',
      title: { en: 'T', ar: 'ت' },
      groupBy: 'building',
      compare: 'previous',
      period: { from: '2026-11-01', to: '2026-11-30', days: 30 },
      previousPeriod: { from: '2026-10-02', to: '2026-10-31', days: 30 },
      lastYearPeriod: null,
      columns,
      dimensions: 1,
      ...lined,
    });
    expect(sheet.headers.map((h) => h.en)).toEqual([
      'Building',
      'Tickets',
      'Tickets (period before)',
      'Tickets change %',
      'Spend',
      'Spend (period before)',
      'Spend change %',
      'Share',
      'Share (period before)',
      'Share change %',
    ]);
    expect(sheet.rows[0]).toEqual([
      'A',
      '3',
      '2',
      '50.0',
      '150.00',
      '100.00',
      '50.0',
      '0.6',
      '0.5',
      '20.0',
    ]);
    expect(sheet.rows[1][0]).toBe('Total');
  });
});
