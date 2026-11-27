/** 由 id 雜湊出的柔和色，成員頭像與名稱用 */
const PALETTE = [
  'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
  'bg-orange-500/15 text-orange-700 dark:text-orange-300',
];

export function memberColorClass(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function initialOf(name: string): string {
  return [...name.trim()][0]?.toUpperCase() ?? '?';
}
