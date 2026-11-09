/** Keep failure status visible without painting the entire command log red. */
export function ErrorDetails({ content, label }: { content: string; label: string }) {
  const trimmed = content.trim();
  const summary = trimmed.split(/\r?\n/, 1)[0] || '';
  const hasMoreDetails = Boolean(trimmed && trimmed !== summary);

  if (!hasMoreDetails) {
    return (
      <div className="flex min-w-0 items-start gap-2 text-xs text-red-700 dark:text-red-300">
        <span className="shrink-0 font-medium">{label}</span>
        {summary && (
          <span className="min-w-0 whitespace-pre-wrap break-words font-mono text-gray-700 dark:text-gray-300">{summary}</span>
        )}
      </div>
    );
  }

  return (
    <details className="group min-w-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-red-700 dark:text-red-300 [&::-webkit-details-marker]:hidden">
        <span className="shrink-0 transition-transform group-open:rotate-90" aria-hidden="true">▸</span>
        <span className="shrink-0 font-medium">{label}</span>
        {summary && (
          <span className="min-w-0 truncate text-gray-600 dark:text-gray-400">{summary}</span>
        )}
      </summary>
      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-gray-50 p-3 font-mono text-xs text-gray-700 dark:bg-gray-900 dark:text-gray-300">{content}</pre>
    </details>
  );
}
