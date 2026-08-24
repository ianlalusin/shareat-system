/**
 * The empty state — docs/tasks/110-reporting-views-and-screens.md Contract §5:
 * "With no data these render zeros and a plain 'no entries for this range', never a
 * crash or a blank page. It is the state Ian will see first."
 */
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
      {message}
    </div>
  );
}
