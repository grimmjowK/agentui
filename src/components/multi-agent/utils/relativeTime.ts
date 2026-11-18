/** 側邊欄用的精簡時間：<1m、5m、3hr、2d */
export function compactAge(iso: string, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}hr` : `${Math.floor(hours / 24)}d`;
}
