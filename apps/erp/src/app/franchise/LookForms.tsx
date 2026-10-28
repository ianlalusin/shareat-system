'use client';

/** T-398 S6d - the two look forms. Pressing the button is the only thing that reads (and logs) anything. */
import { useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { Button, Field, FormGrid, Input, Select, Textarea } from '@/components/ui';
import { viewFranchiseSalesAction, viewFranchiseStockAction } from './actions';

type LookAction = (prev: ReactNode | null, fd: FormData) => Promise<ReactNode>;

/** A press runs the server action once and keeps what it returns. (useState + a transition: the same one-press, one-call, with no auto-resubmit.) */
function useLook(action: LookAction): [ReactNode | null, (e: FormEvent<HTMLFormElement>) => void, boolean] {
  const [result, setResult] = useState<ReactNode | null>(null);
  const [pending, start] = useTransition();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    start(async () => {
      setResult(await action(null, fd));
    });
  };
  return [result, onSubmit, pending];
}

export interface FranchiseeChoice {
  id: string;
  name: string;
}

function Notice({ name }: { name: string }) {
  return <p className="text-sm text-muted">{name} will see that you looked: your name, the time and the reason you type are kept in their access log.</p>;
}

function FranchiseePick({ choices, selected }: { choices: FranchiseeChoice[]; selected: string }) {
  return (
    <Field label="Franchise">
      <Select name="franchiseeOrgId" defaultValue={selected}>
        {choices.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

export function SalesLookForm({ choices, selected, from, to }: { choices: FranchiseeChoice[]; selected: string; from: string; to: string }) {
  const [result, onSubmit, pending] = useLook(viewFranchiseSalesAction);
  const name = choices.find((c) => c.id === selected)?.name ?? 'The franchise';
  return (
    <div className="space-y-6">
      <form method="post" onSubmit={onSubmit} className="space-y-4">
        <FormGrid>
          <FranchiseePick choices={choices} selected={selected} />
          <Field label="From (YYYY-MM-DD)">
            <Input name="from" type="text" defaultValue={from} placeholder="2026-11-02" />
          </Field>
          <Field label="To (YYYY-MM-DD)">
            <Input name="to" type="text" defaultValue={to} placeholder="2026-11-08" />
          </Field>
          <Field label="Reason (optional)" span="full">
            <Textarea name="reason" rows={2} />
          </Field>
        </FormGrid>
        <Notice name={name} />
        <Button type="submit" disabled={pending}>
          Look at sales
        </Button>
      </form>
      {result}
    </div>
  );
}

export function StockLookForm({ choices, selected }: { choices: FranchiseeChoice[]; selected: string }) {
  const [result, onSubmit, pending] = useLook(viewFranchiseStockAction);
  const name = choices.find((c) => c.id === selected)?.name ?? 'The franchise';
  return (
    <div className="space-y-6">
      <form method="post" onSubmit={onSubmit} className="space-y-4">
        <FormGrid>
          <FranchiseePick choices={choices} selected={selected} />
          <Field label="Reason (optional)" span="full">
            <Textarea name="reason" rows={2} />
          </Field>
        </FormGrid>
        <Notice name={name} />
        <Button type="submit" disabled={pending}>
          Look at stock
        </Button>
      </form>
      {result}
    </div>
  );
}
