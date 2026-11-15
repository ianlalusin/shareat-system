/**
 * T-533 S1 - the Set POS mode form on /admin/stores/[id]: mode, a live-from date (live only) and a reason. Saving it does NOT switch anything: the server
 * answers with a plain sentence saying exactly what would happen, and the page shows that as a confirm step, the way the opening date does.
 * A record form like the others on this page (locked until Edit, live checks, what was typed kept after a refusal).
 */
import { EditableRecord } from '@/components/forms';
import { Field, FormGrid, Input, Select, Textarea } from '@/components/ui';
import { ADMIN_STORE_POS_MODE_RULES, nativeAttrs } from '@shareat/domain/field-rules';
import type { TypedView } from '@/lib/keep-typing';
import { reviewStorePosModeAction } from '../actions';

type Mode = 'off' | 'test' | 'live';
const LABEL: Record<Mode, string> = { off: 'Off (sales days come from v1)', test: 'Test (practice, no sales day is booked)', live: 'Live (from the date below)' };

export interface PosModeFormProps {
  readonly storeId: string;
  readonly storeName: string;
  readonly currentMode: Mode;
  /** Today's Manila business date (the earliest a live switch may start). */
  readonly today: string;
  /** What was typed before a refused switch (T-389). */
  readonly typed: TypedView | null;
}

export function PosModeForm({ storeId, storeName, currentMode, today, typed }: PosModeFormProps) {
  return (
    <EditableRecord action={reviewStorePosModeAction} label={`POS mode of ${storeName}`} editText="Change POS mode" hidden={{ storeId }} typed={typed} rules={ADMIN_STORE_POS_MODE_RULES}>
      <FormGrid className="text-sm">
        <Field label="Mode" rule={ADMIN_STORE_POS_MODE_RULES.mode}>
          <Select {...nativeAttrs(ADMIN_STORE_POS_MODE_RULES.mode)} defaultValue={currentMode} className="w-full">
            {(['off', 'test', 'live'] as const).map((m) => (
              <option key={m} value={m}>
                {LABEL[m]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Live from" hint="Live only: the first business day the new POS owns. Today or later." rule={ADMIN_STORE_POS_MODE_RULES.liveFrom}>
          <Input type="date" {...nativeAttrs(ADMIN_STORE_POS_MODE_RULES.liveFrom)} min={today} defaultValue="" className="w-full" />
        </Field>
        <Field span="full" label="Reason" hint="1 to 200 characters. It goes into the audit trail." rule={ADMIN_STORE_POS_MODE_RULES.reason}>
          <Textarea {...nativeAttrs(ADMIN_STORE_POS_MODE_RULES.reason)} defaultValue="" rows={2} className="w-full" />
        </Field>
      </FormGrid>
    </EditableRecord>
  );
}
