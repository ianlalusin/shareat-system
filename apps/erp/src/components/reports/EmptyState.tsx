import { EmptyState as KitEmptyState } from '@/components/ui/EmptyState';

/**
 * The empty state — docs/tasks/110-reporting-views-and-screens.md Contract §5:
 * "With no data these render zeros and a plain 'no entries for this range', never a
 * crash or a blank page. It is the state Ian will see first."
 *
 * T-387 S3: a thin adapter over the kit's EmptyState (magnifier, title = message) so the ten
 * report callers keep their `{message}` API.
 */
export function EmptyState({ message }: { message: string }) {
  return <KitEmptyState illustration="magnifier" title={message} />;
}
