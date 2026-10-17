'use client';

import { useState, type FormEvent } from 'react';
import { Button, Card, ErrorLine, PageTitle } from '@/components/ui';
import { useCustomerData } from '@/data/provider';
import type { Member } from '@/data/types';

const inputClass = 'mt-1 min-h-[44px] w-full rounded-md border border-input bg-background px-3 text-base';

function SignIn({ onDone }: { onDone: (m: Member) => void }) {
  const data = useCustomerData();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await data.signIn(phone, password);
    setBusy(false);
    if (r.ok) onDone(r.value);
    else setError(r.reason);
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-3">
      <label className="block text-sm font-medium">
        Mobile number
        <input name="phone" inputMode="numeric" autoComplete="tel" maxLength={11} value={phone} onChange={(e) => setPhone(e.target.value)} className={inputClass} />
      </label>
      <label className="block text-sm font-medium">
        Password
        <input name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
      </label>
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      <Button type="submit" className="w-full" disabled={busy}>
        Sign in
      </Button>
      <p className="text-xs text-muted-foreground">Forgot password? Ask a manager at the store.</p>
    </form>
  );
}

function SignUp({ onDone }: { onDone: (m: Member) => void }) {
  const data = useCustomerData();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [consent, setConsent] = useState(false);
  const [code, setCode] = useState('');
  const [demoCode, setDemoCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function askCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await data.requestSignUpCode(phone);
    setBusy(false);
    if (r.ok) setDemoCode(r.value.code);
    else setError(r.reason);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await data.signUp({ name, phone, password, code, consent });
    setBusy(false);
    if (r.ok) onDone(r.value);
    else setError(r.reason);
  }

  const codeStep = demoCode !== null;

  return (
    <form onSubmit={(e) => void (codeStep ? create(e) : askCode(e))} className="space-y-3">
      <label className="block text-sm font-medium">
        Your name
        <input name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} disabled={codeStep} className={inputClass} />
      </label>
      <label className="block text-sm font-medium">
        Mobile number
        <input name="phone" inputMode="numeric" autoComplete="tel" maxLength={11} placeholder="09XXXXXXXXX" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={codeStep} className={inputClass} />
      </label>
      <label className="block text-sm font-medium">
        Password (at least 8 letters or numbers)
        <input name="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={codeStep} className={inputClass} />
      </label>
      <label className="flex min-h-[44px] items-start gap-3 text-sm">
        <input
          type="checkbox"
          name="consent"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-1 h-5 w-5 accent-[hsl(var(--primary))]"
        />
        <span>I agree that Shareat keeps my name and mobile number to run my account, as described in the privacy notice below.</span>
      </label>
      {codeStep ? (
        <div className="space-y-2">
          <p className="rounded-md bg-muted px-3 py-2 text-sm">Demo code: {demoCode} (nothing is texted in this demo)</p>
          <label className="block text-sm font-medium">
            6-digit code
            <input name="code" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} className={inputClass} />
          </label>
        </div>
      ) : null}
      {error ? <ErrorLine>{error}</ErrorLine> : null}
      {codeStep ? (
        <Button variant="ghost" className="w-full" onClick={() => { setDemoCode(null); setCode(''); setError(null); }}>
          Change details
        </Button>
      ) : null}
      {!consent ? <p className="text-xs text-muted-foreground">Tick the box above to continue.</p> : null}
      <Button type="submit" className="w-full" disabled={busy || !consent}>
        {codeStep ? 'Create my account' : 'Send me a code'}
      </Button>
    </form>
  );
}

export default function Page() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [member, setMember] = useState<Member | null>(null);

  if (member) {
    return (
      <Card className="mt-4 space-y-2 text-center">
        <p className="text-lg font-bold">Hello, {member.name}</p>
        <p className="text-sm text-muted-foreground">You are signed in as {member.phone}.</p>
        <Button variant="secondary" onClick={() => setMember(null)}>
          Sign out
        </Button>
      </Card>
    );
  }

  return (
    <div>
      <PageTitle hint="An account is optional. You can order without one.">Account</PageTitle>
      <div className="mb-4 grid grid-cols-2 gap-2" role="tablist">
        <Button role="tab" aria-selected={mode === 'signin'} variant={mode === 'signin' ? 'primary' : 'secondary'} onClick={() => setMode('signin')}>
          Sign in
        </Button>
        <Button role="tab" aria-selected={mode === 'signup'} variant={mode === 'signup' ? 'primary' : 'secondary'} onClick={() => setMode('signup')}>
          Sign up
        </Button>
      </div>
      <Card>{mode === 'signin' ? <SignIn onDone={setMember} /> : <SignUp onDone={setMember} />}</Card>
      <p className="mt-4 text-xs text-muted-foreground">
        Privacy notice: if you do not use your account for 3 years, it is deleted, along with your name and mobile number.
      </p>
    </div>
  );
}
