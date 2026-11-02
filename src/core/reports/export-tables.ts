// ============================================================================
// The compound's export: its fixed tables and columns (ADR 0086)
// ============================================================================
//
// What the manager's export of the compound holds, written here and nowhere
// else, pinned by a unit test: the register, the work and its costs, the
// stock, the common meters, the budget and the capital plans. Each table is
// one CSV, its columns as listed, read through the tenant transaction (RLS)
// a page at a time by id.
//
// Never a person (ADR 0036 is the only way a person's data leaves): no
// name, phone, email, national ID or photo; no account id (who did what);
// no free text anyone wrote (a description, a note, a reason's words, a
// vendor's name); no occupancy, household or worker; nothing a unit owes or
// paid; a household's meter or its readings; a ticket's unit (what a
// household asked for). Places, things, codes, amounts and dates only.
//
// The identifiers below are constants of this file, never input: the SQL is
// built from them alone.

export interface ExportColumn {
  name: string;
  /** A figure we wrote (never formula-defused), else text. */
  kind: 'text' | 'number';
}

export interface ExportTable {
  /** The CSV's name in the archive: `<file>.csv`. */
  file: string;
  table: string;
  columns: ExportColumn[];
  /** A constant condition on the table's own rows, if any. */
  where?: string;
}

/** `'code area_sqm#'`: `#` marks a figure. */
const cols = (spec: string): ExportColumn[] =>
  spec
    .split(/\s+/)
    .filter(Boolean)
    .map((c) =>
      c.endsWith('#')
        ? { name: c.slice(0, -1), kind: 'number' }
        : { name: c, kind: 'text' },
    );

export const EXPORT_TABLES: readonly ExportTable[] = [
  { file: 'buildings', table: 'buildings', columns: cols('id name') },
  {
    file: 'units',
    table: 'units',
    columns: cols('id code building_id floor# unit_type area_sqm#'),
  },
  {
    file: 'common_areas',
    table: 'common_areas',
    columns: cols('id code kind building active'),
  },
  {
    file: 'asset_types',
    table: 'asset_types',
    columns: cols('id key category_id expected_life_years# active'),
  },
  {
    file: 'assets',
    table: 'assets',
    columns: cols(
      'id code type_id parent_id unit_id common_area_id commissioned_on purchase_value# replacement_cost# expected_life_years# warranty_starts_on warranty_ends_on criticality status condition retired_at',
    ),
  },
  {
    file: 'ticket_categories',
    table: 'ticket_categories',
    columns: cols('id key active'),
  },
  {
    // The compound's work: never a ticket's unit, reporter or words, and
    // never a sensitive ticket (ADR 0081), whoever exports.
    file: 'tickets',
    table: 'tickets',
    columns: cols(
      'id number# category_id priority status kind origin asset_id common_area_id created_at completed_at closed_at cancelled_at',
    ),
    where: 'NOT sensitive',
  },
  {
    file: 'ticket_costs',
    table: 'ticket_cost_entries',
    columns: cols(
      'id ticket_id kind quantity# unit_amount# amount# item_id entered_at voided_at',
    ),
  },
  {
    file: 'maintenance_plans',
    table: 'maintenance_plans',
    columns: cols(
      'id asset_id category_id trigger every# unit next_due_on lead_days# grace_days# active',
    ),
  },
  {
    file: 'plan_occurrences',
    table: 'maintenance_plan_occurrences',
    columns: cols('id plan_id due_on status ticket_id done_on on_time'),
  },
  {
    file: 'stores',
    table: 'stores',
    columns: cols('id code common_area_id active'),
  },
  {
    file: 'stock_items',
    table: 'stock_items',
    columns: cols(
      'id sku name_en name_ar unit reorder_level# average_cost# active',
    ),
  },
  {
    file: 'stock_levels',
    table: 'stock_levels',
    columns: cols('id store_id item_id quantity# reserved#'),
  },
  {
    file: 'stock_movements',
    table: 'stock_movements',
    columns: cols(
      'id item_id store_id kind quantity# unit_cost# ticket_id occurred_at',
    ),
  },
  {
    // The common meters only: a household's meter is its own (ADR 0069).
    file: 'meters',
    table: 'meters',
    columns: cols(
      'id code kind mode multiplier# common_area_id asset_id active',
    ),
    where: 'unit_id IS NULL',
  },
  {
    file: 'meter_readings',
    table: 'meter_readings',
    columns: cols('id meter_id read_on value# reset'),
    where:
      'superseded_at IS NULL AND meter_id IN (SELECT m.id FROM meters m WHERE m.unit_id IS NULL)',
  },
  {
    file: 'energy_tariffs',
    table: 'energy_tariffs',
    columns: cols('id kind effective_on price_per_unit#'),
  },
  {
    file: 'budgets',
    table: 'finance_budgets',
    columns: cols('id fiscal_year# starts_on ends_on status'),
  },
  {
    file: 'budget_lines',
    table: 'finance_budget_lines',
    columns: cols('id budget_id category amount#'),
  },
  {
    // What was spent on each line: never the vendor's name or the invoice.
    file: 'expenses',
    table: 'finance_expenses',
    columns: cols('id number# budget_line_id amount# spent_on voided_at'),
  },
  {
    file: 'capital_plans',
    table: 'capital_plans',
    columns: cols('id year# status submitted_at approved_at'),
  },
  {
    // A line's words are the staff's: never exported.
    file: 'capital_plan_lines',
    table: 'capital_plan_lines',
    columns: cols('id plan_id asset_id amount# source'),
  },
];

/**
 * Column names that would carry a person or anybody's words: none of the
 * tables may list one (the unit test's guard).
 */
export const NEVER_EXPORTED =
  /(^|_)(name_?|phone|email|national|passport|photo|note|description|reason|comment|words|text|body|title|vendor|reference|account|by|password|token|hash|serial)(_|$)/;
