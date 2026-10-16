'use client';

/**
 * The "How" choice for settling an owner's receivable. Only a write-off needs an administrator's own PIN (T-412 Tier P,
 * DEF-654), so the PIN box appears only then. A convenience: the SERVER decides which branch ran and checks the PIN.
 */
import { useState } from 'react';
import { Input, Select } from '@/components/ui';

export function SettleHow() {
  const [how, setHow] = useState('');
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">How</span>
        <Select name="how" required value={how} onChange={(e) => setHow(e.target.value)} className="w-full">
          <option value="" disabled>
            Choose…
          </option>
          <option value="cash">Cash back — the money returns to an account</option>
          <option value="pay">Recover from pay — becomes a salary advance</option>
          <option value="writeoff">Write off — it becomes a drawing</option>
        </Select>
      </label>
      {how === 'writeoff' && (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Administrator PIN (write-off only)</span>
          <Input name="adminPin" type="password" inputMode="numeric" autoComplete="off" maxLength={6} required className="w-full" />
          <span className="text-xs text-neutral-500">An administrator must approve a write-off with their own PIN.</span>
        </label>
      )}
    </>
  );
}
