type ShellConnectionOverlayProps = {
  mode: 'loading' | 'connect' | 'connecting';
  description: string;
  loadingLabel: string;
  connectLabel: string;
  connectTitle: string;
  connectingLabel: string;
  errorMessage?: string | null;
  onConnect: () => void;
};

export default function ShellConnectionOverlay({
  mode,
  description,
  loadingLabel,
  connectLabel,
  connectTitle,
  connectingLabel,
  errorMessage = null,
  onConnect,
}: ShellConnectionOverlayProps) {
  if (mode === 'loading') {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-gray-900/90 backdrop-blur-[2px]">
        <div className="flex items-center space-x-3 rounded-xl border border-gray-700/70 bg-gray-800/90 px-5 py-3.5 text-gray-200 shadow-lg">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-gray-400 border-t-transparent" />
          <span className="text-sm font-medium">{loadingLabel}</span>
        </div>
      </div>
    );
  }

  if (mode === 'connect') {
    return (
      <div
        className={`absolute inset-0 flex items-center justify-center p-4 ${
          errorMessage ? 'bg-gray-900/65 backdrop-blur-[1px]' : 'bg-gray-900/90 backdrop-blur-[2px]'
        }`}
      >
        <div className="w-full max-w-md rounded-xl border border-gray-700/80 bg-gray-800/95 p-6 text-center shadow-2xl">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-gray-700/70 text-gray-300">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          </div>

          <p className="px-2 text-sm font-medium text-gray-200">{description}</p>

          {errorMessage && (
            <div className="mt-3 rounded-lg border border-red-500/40 bg-red-950/60 px-3.5 py-2.5 text-left text-xs leading-relaxed text-red-200">
              {errorMessage}
            </div>
          )}

          <div className="mt-5 flex justify-center">
            <button
              onClick={onConnect}
              className="inline-flex items-center justify-center space-x-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
              title={connectTitle}
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              <span>{connectLabel}</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-gray-900/85 p-4 backdrop-blur-[2px]">
      <div className="w-full max-w-md rounded-xl border border-gray-700/80 bg-gray-800/95 p-6 text-center shadow-2xl">
        <div className="flex items-center justify-center space-x-3 text-amber-400">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
          <span className="text-sm font-medium">{connectingLabel}</span>
        </div>
        <p className="mt-2.5 px-2 text-xs text-gray-400">{description}</p>
      </div>
    </div>
  );
}
