/** T-642: the test-result badge, shared by the numbered order (a client file) and the "Not in use" rows (the page). No hooks, no directive. */
import { Badge } from '@/components/ui';

export function TestBadge({ test, toolCalling }: { test: 'never' | 'passed' | 'failed'; toolCalling: boolean | null }) {
  if (test === 'passed') return <Badge tone="success" label={toolCalling ? 'Test passed, can call tools' : 'Test passed, plain answers only'} />;
  if (test === 'failed') return <Badge tone="danger" label="Last test failed" />;
  return <Badge tone="closed" label="Not tested" />;
}
