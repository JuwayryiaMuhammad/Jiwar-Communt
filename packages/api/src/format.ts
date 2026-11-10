/** Display helpers shared by the dashboards. Dates, numbers and amounts are in @jiwar/i18n (useFormat). */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '—';
}
