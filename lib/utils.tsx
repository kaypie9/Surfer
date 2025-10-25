export function cn(...a: Array<string | undefined | null | false>) {
  return a.filter(Boolean).join(' ');
}
