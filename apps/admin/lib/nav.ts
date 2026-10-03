/** Only same-app paths: never follow an absolute or protocol-relative URL. */
export function safeNext(value: string | null): string {
  return value && /^\/(?![/\\])/.test(value) && !value.startsWith('/bff') ? value : '/';
}
