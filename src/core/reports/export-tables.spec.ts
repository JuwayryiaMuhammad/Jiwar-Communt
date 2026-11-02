import { EXPORT_TABLES, NEVER_EXPORTED } from './export-tables';

/** Labels of places and things, not of people: allowed by name. */
const LABELS_OF_THINGS = [
  'buildings.name',
  'stock_items.name_en',
  'stock_items.name_ar',
];

describe('the compound’s export (ADR 0086)', () => {
  it('holds these tables, in this order', () => {
    expect(EXPORT_TABLES.map((t) => t.table)).toEqual([
      'buildings',
      'units',
      'common_areas',
      'asset_types',
      'assets',
      'ticket_categories',
      'tickets',
      'ticket_cost_entries',
      'maintenance_plans',
      'maintenance_plan_occurrences',
      'stores',
      'stock_items',
      'stock_levels',
      'stock_movements',
      'meters',
      'meter_readings',
      'energy_tariffs',
      'finance_budgets',
      'finance_budget_lines',
      'finance_expenses',
      'capital_plans',
      'capital_plan_lines',
    ]);
  });

  it('never a column that would carry a person or anybody’s words', () => {
    for (const t of EXPORT_TABLES)
      for (const c of t.columns)
        if (!LABELS_OF_THINGS.includes(`${t.table}.${c.name}`))
          expect([t.table, c.name, NEVER_EXPORTED.test(c.name)]).toEqual([
            t.table,
            c.name,
            false,
          ]);
  });

  it('never a ticket’s unit, a sensitive ticket, a household’s meter or its readings', () => {
    const of = (table: string) => EXPORT_TABLES.find((t) => t.table === table)!;
    expect(of('tickets').columns.map((c) => c.name)).not.toContain('unit_id');
    expect(of('tickets').where).toBe('NOT sensitive');
    expect(of('meters').where).toBe('unit_id IS NULL');
    expect(of('meter_readings').where).toContain('m.unit_id IS NULL');
  });

  it('identifiers are plain names, every table has an id', () => {
    for (const t of EXPORT_TABLES) {
      expect(t.table).toMatch(/^[a-z_]+$/);
      expect(t.file).toMatch(/^[a-z_]+$/);
      expect(t.columns[0].name).toBe('id');
      for (const c of t.columns) expect(c.name).toMatch(/^[a-z_]+$/);
    }
  });
});
