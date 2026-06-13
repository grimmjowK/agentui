interface CommandChipProps {
  commandName: string;
  onDismiss: () => void;
}

export default function CommandChip({ commandName, onDismiss }: CommandChipProps) {
  return (
    <div className="mb-1.5 flex items-center gap-1">
      <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/8 px-2.5 py-0.5 text-xs font-medium text-primary">
        {commandName}
        <button
          type="button"
          onClick={onDismiss}
          className="ml-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full transition-colors hover:bg-primary/20"
          aria-label="移除命令"
        >
          <svg className="h-2.5 w-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </span>
    </div>
  );
}
