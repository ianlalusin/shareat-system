/**
 * Read-only Firestore -> raw specimen — docs/tasks/117-replay-harness-stage-a.md Part 2 /
 * Contract §5.
 *
 * Build order (task spec, "Build order — capture is NOT the first thing"): Part 1
 * (convert + replay against hand-written fixtures) comes first and is what this repo
 * actually exercises. Part 2 — this file — needs credentials Ian must supply
 * (`CAPTURE_HUB_SA_KEY`, `CAPTURE_ERP_SA_KEY`, `CAPTURE_SALT`) that are **not present** in
 * this environment's `.env.local` (verified 2026-08-23 — only the variables in
 * `.env.example` are set). So this file is wired, proven to skip cleanly (invariant 10,
 * `tests/capture.test.ts`), and NOT exercised against production. Nothing in this file
 * ever opens a network connection in this environment.
 *
 * SCOPE DECISION, stated plainly rather than silently narrowed (task's "report a spec
 * defect, don't work around it"): Contract's file list names `capture.ts` as "read-only
 * Firestore -> raw specimen", which on a literal reading implies a working Firestore
 * client. Actually wiring `firebase-admin` now would be: (a) untestable in this
 * environment — there is no credential to prove it against, so any code path touching a
 * real Admin SDK call would be unexercised and unreviewable; (b) a new dependency this
 * package does not otherwise need; and (c) exactly the kind of code the task explicitly
 * says not to run ("Do not attempt to run it against production"). So the credential
 * guard and the coverage-driven SAMPLING decision (`shouldCapture`, via taxonomy.ts) are
 * fully implemented and tested here — that is the part Stage A can actually prove. The
 * concrete Firestore-backed `FirestoreReader` is left as an injected interface for
 * whoever wires Part 2 for real (T-114 territory), never called by this module.
 */
import { readFileSync } from 'node:fs';

import type { CaseClass } from './taxonomy';
import { shouldCapture } from './taxonomy';
import { redactDocument, type DocKind } from './pseudonymise';

export interface CaptureCredentials {
  hubSaKey: string;
  erpSaKey: string;
  salt: string;
}

export interface CaptureSkipped {
  skipped: true;
  reason: string;
  missing: readonly string[];
}

/** Each service-account credential may arrive by PATH (preferred) or inline. */
const SA_SOURCES = [
  { key: 'CAPTURE_HUB_SA_KEY', field: 'hubSaKey' },
  { key: 'CAPTURE_ERP_SA_KEY', field: 'erpSaKey' },
] as const;

/**
 * How a credential file is read. Injected so `capture.test.ts` can prove the path branch
 * without writing a real key to disk — and so nothing in this module reaches the filesystem
 * during a unit run that is only exercising the env branch.
 */
export type FileReader = (path: string) => string;

const defaultFileReader: FileReader = (path) => readFileSync(path, 'utf8');

/**
 * A credential file that exists but is not a service account is worth catching HERE, at load,
 * rather than as an opaque auth failure against a live project later. Checks shape only — it
 * never inspects, returns or logs the key material itself.
 */
function assertLooksLikeServiceAccount(raw: string, source: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return `${source} is not valid JSON`;
  }
  if (typeof parsed !== 'object' || parsed === null) return `${source} is not a JSON object`;
  const obj = parsed as Record<string, unknown>;
  for (const field of ['type', 'project_id', 'client_email', 'private_key']) {
    if (typeof obj[field] !== 'string' || (obj[field] as string).length === 0) {
      return `${source} is missing "${field}" — it does not look like a service-account key`;
    }
  }
  if (obj.type !== 'service_account') {
    return `${source} has type "${String(obj.type)}", expected "service_account"`;
  }
  return null;
}

/**
 * Reads capture credentials from the given environment source (defaults to
 * `process.env` — the caller may inject a fake map for tests, which is how
 * `capture.test.ts` proves the guard without touching real env vars).
 *
 * Each service-account credential is accepted **two ways**, and the FILE form is preferred:
 *
 * | | |
 * |---|---|
 * | `CAPTURE_ERP_SA_KEY_FILE=./secrets/erp.sa.json` | **Preferred.** The key never enters an env var, a shell history, a process listing, or a `printenv` dump. `secrets/` is gitignored — see `secrets/README.md` |
 * | `CAPTURE_ERP_SA_KEY={"type":"service_account",…}` | Still supported. One line, escapes intact |
 *
 * Setting BOTH forms for the same credential is rejected rather than silently resolved. A
 * precedence rule here would be a rule nobody remembers under pressure, and "which key did it
 * actually use" is the worst question to have to ask about a production credential.
 *
 * Relative paths resolve against `process.cwd()`, which is the repo root for every npm script.
 *
 * NEVER reads `FIREBASE_SERVICE_ACCOUNT_KEY` — that is `@shareat/core/env`'s production
 * Firebase Admin credential, a different credential for a different purpose (bible §7.1's
 * auth bridge). Falling back to it here would be exactly the defect the task spec calls
 * out by name. There is deliberately no fallback branch of any kind below.
 *
 * **No branch below ever puts key material into a return value's `reason`, an exception
 * message, or a log line.** Failures name the PATH or the VARIABLE, never the content — a
 * credential leaked through an error message is leaked just as thoroughly as one committed.
 */
export function loadCaptureCredentials(
  envSource: Readonly<Record<string, string | undefined>> = process.env,
  readFile: FileReader = defaultFileReader,
): CaptureCredentials | CaptureSkipped {
  const present = (key: string): boolean => Boolean(envSource[key] && envSource[key]!.trim() !== '');

  const missing: string[] = [];
  const problems: string[] = [];
  const resolved: Record<string, string> = {};

  for (const { key, field } of SA_SOURCES) {
    const fileKey = `${key}_FILE`;
    const hasInline = present(key);
    const hasFile = present(fileKey);

    if (hasInline && hasFile) {
      problems.push(`${key} and ${fileKey} are BOTH set — set exactly one, not both`);
      continue;
    }
    if (!hasInline && !hasFile) {
      // The canonical variable NAME only. `missing` is a machine-readable list a caller
      // can match on; the two-forms explanation belongs in `reason`, not smuggled into a
      // list entry as prose. (Same lesson as the ETL quarantine reason_code: a value you
      // might want to group or compare must not be a sentence.)
      missing.push(key);
      continue;
    }

    if (hasFile) {
      const path = envSource[fileKey]!.trim();
      let raw: string;
      try {
        raw = readFile(path);
      } catch {
        // The path, never the contents, and never the underlying error object — a read error
        // on some platforms echoes part of the file it failed on.
        problems.push(`${fileKey} points at ${path}, which could not be read`);
        continue;
      }
      const shapeProblem = assertLooksLikeServiceAccount(raw, path);
      if (shapeProblem) {
        problems.push(shapeProblem);
        continue;
      }
      resolved[field] = raw;
    } else {
      resolved[field] = envSource[key]!;
    }
  }

  if (!present('CAPTURE_SALT')) missing.push('CAPTURE_SALT');

  if (missing.length > 0 || problems.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
    if (problems.length > 0) parts.push(problems.join('; '));
    return {
      skipped: true,
      missing,
      reason:
        `Capture skipped — ${parts.join('. ')}. These are read-only capture credentials Ian ` +
        'supplies locally (never committed): a service-account JSON per project, preferably as a ' +
        'file under secrets/ referenced by CAPTURE_*_SA_KEY_FILE, plus CAPTURE_SALT. They are ' +
        'separate from FIREBASE_SERVICE_ACCOUNT_KEY and capture never falls back to it. ' +
        'See secrets/README.md and docs/tasks/117-replay-harness-stage-a.md.',
    };
  }

  return {
    hubSaKey: resolved.hubSaKey!,
    erpSaKey: resolved.erpSaKey!,
    salt: envSource.CAPTURE_SALT!,
  };
}

/** A single Firestore document as capture would see it, before classification/redaction. */
export interface CaptureCandidate {
  docKind: DocKind;
  storeCode: string;
  /** The (business-)day this document belongs to — capture is day-scoped (Contract §5). */
  businessDate: string;
  doc: Record<string, unknown>;
}

/**
 * The seam a real Part-2 implementation plugs into: something that can list yesterday's
 * candidate documents from Firestore, read-only. NOT implemented against a live
 * `firebase-admin` client here — see this file's header. `capture.test.ts` exercises the
 * sampler and pseudonymisation wiring below against an in-memory fake of this interface,
 * which is sufficient to prove the sampling and redaction logic without ever needing a
 * credential.
 */
export interface FirestoreReader {
  listYesterdaysCandidates(): Promise<CaptureCandidate[]>;
}

/** How a `CaptureCandidate` maps to a taxonomy case class. Injected rather than hardcoded
 *  because the real classification rule (Contract §1's table) depends on fields this
 *  module has no opinion about (discount presence, void status, comps, etc.) — that
 *  belongs to whoever wires the real reader, not to the sampler itself. */
export type Classifier = (candidate: CaptureCandidate) => CaseClass;

export interface SampledSpecimen {
  caseClass: CaseClass;
  candidate: CaptureCandidate;
  redactedDoc: Record<string, unknown>;
}

export interface CaptureRunResult {
  skipped: false;
  sampled: SampledSpecimen[];
  /** Every candidate NOT sampled, and why (its class was already at target). */
  skippedCandidates: { caseClass: CaseClass; reason: string }[];
}

/**
 * The coverage-driven sampling loop (Contract §1, invariants 1–2): walks candidates in
 * order, classifies each, captures it (redacted) only if `shouldCapture` says its class
 * is still below target, and updates the running count so later candidates in the same
 * run see the effect of earlier captures — this is what keeps a single run from
 * over-capturing a class that fills up partway through.
 *
 * `startingCounts` lets the caller seed with what is already on disk (capture is
 * idempotent per Contract §5 — re-running for the same day must not add duplicates or
 * blow past target), so a real Part-2 caller passes in a corpus scan's counts here.
 */
export function sampleCandidates(
  candidates: readonly CaptureCandidate[],
  classify: Classifier,
  salt: string,
  startingCounts: ReadonlyMap<CaseClass, number> = new Map(),
): CaptureRunResult {
  const counts = new Map(startingCounts);
  const sampled: SampledSpecimen[] = [];
  const skippedCandidates: CaptureRunResult['skippedCandidates'] = [];

  for (const candidate of candidates) {
    const caseClass = classify(candidate);
    const current = counts.get(caseClass) ?? 0;

    if (!shouldCapture(caseClass, current)) {
      skippedCandidates.push({ caseClass, reason: `class ${caseClass} already at target (${current} captured)` });
      continue;
    }

    const redactedDoc = redactDocument(candidate.docKind, candidate.doc, salt);
    sampled.push({ caseClass, candidate: { ...candidate, doc: redactedDoc }, redactedDoc });
    counts.set(caseClass, current + 1);
  }

  return { skipped: false, sampled, skippedCandidates };
}

/**
 * The entry point a scheduled job would call. Guards on credentials first (invariant 10)
 * and returns the skip result untouched if they are absent — this is the only path this
 * function takes in this environment, and `capture.test.ts` proves exactly that.
 *
 * If credentials WERE present, this would go on to build a real `FirestoreReader` from
 * `hubSaKey`/`erpSaKey` and call `sampleCandidates`. That construction is deliberately
 * NOT implemented — see this file's header comment.
 */
export async function runCapture(
  envSource: Readonly<Record<string, string | undefined>> = process.env,
): Promise<CaptureSkipped> {
  const creds = loadCaptureCredentials(envSource);
  if ('skipped' in creds) {
    // eslint-disable-next-line no-console -- deliberate: Contract §5's coverage report
    // and this skip message are meant to be seen by whoever runs the job.
    console.warn(creds.reason);
    return creds;
  }

  // Credentials present: real Part-2 execution is not implemented in Stage A. Failing
  // loudly here (rather than silently no-op'ing) matters — a caller who somehow has
  // credentials in a future environment must not mistake a silent no-op for a completed,
  // reconciled capture run (bible §15.6: "every background job reports success WITH
  // COUNTS, never a bare done").
  throw new Error(
    'Capture credentials are present, but the Firestore-backed capture run (Part 2 execution) ' +
      'is not implemented in this task — see capture.ts header. Build the FirestoreReader ' +
      'before calling runCapture() with real credentials.',
  );
}
