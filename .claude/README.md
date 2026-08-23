# `.claude/settings.json` — why these deny rules exist, and why they are HERE

`settings.json` blocks `Edit` and `Write` into the four reference repos —
`ERP-rebuild`, `POS`, `CUSTOMER`, `Shareat Website` — for sessions working in **this**
project. It is the harness enforcement of bible §2 rule 1: those four are read-only
references, and a defect found in one is logged in `docs/DEFECTS-REGISTER.md` and fixed
here, never patched at the source.

## Why project scope, not global

**These are live systems Ian actively develops.** A global deny would block a session
opened in `webapps\POS` to work on POS — which is normal, legitimate work. The read-only
rule is a property of *this rebuild project*, not of those repos in general.

Project settings load only for sessions rooted here, so:

| Session opened in | Can write to POS? |
|---|---|
| `webapps\shareat-system` | **No** — denied. Correct: the rebuild never patches a reference |
| `webapps\POS` | **Yes** — normal POS development is unaffected |

## Two caveats, stated plainly

1. **The paths are absolute and machine-specific.** On a different machine they simply do
   not match, and nothing is enforced. The *rule* lives in `PROJECT_BIBLE.md` §2 rule 1 and
   `AGENTS.md`; this file is a convenience on top of it, never the mechanism.
2. **The `//C:/...` glob syntax is unverified on Windows.** Testing it honestly would mean
   attempting a write into a live production repo, which is not worth doing to confirm a
   convenience. Treat it as belt-and-braces.

Reading those repos is *encouraged* and never prompts — see `~/.claude/settings.json`,
which allows the read-only tools and shell verbs globally. Read them often; read them as
requirements, not as design (bible §1.2b).
