// Decide which semver bump — if any — a batch of merged commits earns.
//
// release.yml used to be workflow_dispatch only, so a human typed
// patch/minor/major and that was the whole decision. Now a push to main cuts
// the release itself, and something has to make that decision without a
// human: this module. It reads the conventional-commit subjects landed since
// the last release tag and resolves them to one word the workflow feeds into
// the existing preflight, unchanged.
//
// It lives here rather than as shell inside the YAML because the rules below
// are real logic with real edge cases (pre-1.0 breaking changes, multi-line
// bodies, unparseable subjects) and a bug in them either ships a release
// nobody asked for or — worse — silently ships nothing. Shell in a workflow
// is unreachable by the test suite; this is not.
//
// CLI: git log --format=%B%x00 <range> | node --import tsx scripts/resolve-release-bump.ts <currentVersion>

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ReleaseBump = 'major' | 'minor' | 'patch' | 'none';

// Ordered weakest to strongest; the resolver keeps the maximum across all
// commits, so one `feat` among twenty `fix`es still produces a minor.
const RANK: Record<ReleaseBump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

// Conventional-commit subject: type, optional scope, optional `!`, then the
// colon. The scope is `[^)]*` rather than a word because this repo's own
// history uses multi-part scopes (`feat(shell,theme): ...`).
const SUBJECT_RE = /^([A-Za-z]+)(?:\(([^)]*)\))?(!)?:/;

// Types that describe work with no user-visible change to the shipped app.
// They contribute NOTHING, on purpose: a macOS release run packages, signs and
// notarises two architectures, and Apple's notary queue has taken anywhere
// from 30 minutes to over two hours on identical inputs. A README typo must
// not spend that, and must not push a version at every installed app that
// contains nothing for them.
const NON_CONTRIBUTING_TYPES = new Set(['docs', 'chore', 'ci', 'test', 'style', 'build']);

// This workflow's own bump commits. Skipped entirely so a release can never
// be the reason for the next release.
const RELEASE_COMMIT_RE = /^chore\(release\):/i;

// A `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer, anchored to the start of
// a line — the conventional-commits spec puts it in the footer block, and an
// unanchored match would fire on prose like "this is not a BREAKING CHANGE:
// the API is untouched". Both spellings are spec-legal aliases.
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/m;

function isBreaking(message: string): boolean {
  const [subject = ''] = message.split('\n');
  const match = SUBJECT_RE.exec(subject.trim());
  if (match?.[3] === '!') return true;
  // Only the body is searched for the footer, so a subject that happens to
  // read `fix: BREAKING CHANGE: ...` is judged by its `!` (or lack of one).
  return BREAKING_FOOTER_RE.test(message.slice(subject.length));
}

function bumpForCommit(message: string, currentMajor: number): ReleaseBump {
  const [rawSubject = ''] = message.split('\n');
  const subject = rawSubject.trim();
  if (subject.length === 0) return 'none';
  if (RELEASE_COMMIT_RE.test(subject)) return 'none';

  if (isBreaking(message)) {
    // Pre-1.0, semver (§4) makes the MINOR the breaking axis: 0.y.z is
    // explicitly "anything may change at any time". Resolving to `major`
    // here would have a merge decide, unilaterally and irreversibly, that
    // this app is 1.0.0 — a product call, not a workflow's. Cut 1.0.0 by
    // hand through workflow_dispatch when it is actually true.
    return currentMajor === 0 ? 'minor' : 'major';
  }

  const match = SUBJECT_RE.exec(subject);
  // Type matching is case-insensitive; `Fix: ...` is a sloppy `fix`, not an
  // unknown type. Scope is optional and never affects the bump.
  const type = match?.[1]?.toLowerCase();

  if (type === 'feat') return 'minor';
  if (type !== undefined && NON_CONTRIBUTING_TYPES.has(type)) return 'none';

  // Everything else — `fix`, `perf`, `refactor`, a type nobody has heard of,
  // or a subject that is not conventional-commit shaped at all (`Merge pull
  // request #14 from ...`, `wip`, `asdf`) — is a patch. The bias is
  // deliberate and it is toward releasing: an unparseable subject means a
  // real change landed with a sloppy message, and under-releasing hides a
  // shipped fix from every installed app, which is strictly worse than an
  // extra patch version nobody notices.
  return 'patch';
}

export function resolveReleaseBump(currentVersion: string, commitMessages: string[]): ReleaseBump {
  // Only the major matters, and only for the pre-1.0 breaking rule. An
  // unparseable version is treated as pre-1.0, which is the cautious side:
  // release.yml's preflight rejects a malformed package.json version anyway,
  // so this never gets to matter in practice.
  const currentMajor = Number(/^(\d+)\./.exec(currentVersion)?.[1] ?? 0);

  let bump: ReleaseBump = 'none';
  for (const message of commitMessages) {
    const candidate = bumpForCommit(message, currentMajor);
    if (RANK[candidate] > RANK[bump]) bump = candidate;
  }
  return bump;
}

// Commit messages are multi-line and their content is arbitrary: quotes,
// backticks, `$(...)`, blank lines, and lines that look like delimiters all
// appear in this repo's real history (read `git log -1 v0.1.7..HEAD`). So the
// CLI takes them on stdin, NUL-delimited, never as argv:
//   - argv would have to survive shell interpolation in the workflow, where
//     a body containing `$(...)` or a lone `"` is a quoting hazard at best
//     and a command-injection hole at worst;
//   - a newline or blank-line delimiter cannot work, because bodies contain
//     both;
//   - NUL is the one byte git guarantees is absent from a commit message, and
//     `git log --format=%B%x00` emits exactly this framing.
// A trailing empty segment after the final NUL is dropped; nothing else is.
export function parseCommitStream(raw: string): string[] {
  const parts = raw.split('\0');
  if (parts[parts.length - 1]?.trim() === '') parts.pop();
  return parts.filter((part) => part.trim().length > 0);
}

function main(argv: string[]): void {
  if (argv.length !== 1) {
    console.error(
      'usage: git log --format=%B%x00 <range> | node --import tsx scripts/resolve-release-bump.ts <currentVersion>',
    );
    process.exit(2);
  }
  const [currentVersion] = argv as [string];
  // fd 0 read synchronously: the input is a git log, bounded by one release
  // cycle's worth of commits, and sync keeps the exit-code discipline simple.
  // An empty stdin is legitimate (no commits since the tag) and resolves to
  // `none`, so a read failure on a closed fd is not an error either.
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  // Exactly the word, no trailing newline, so the workflow can use it raw in
  // `echo "bump=$(...)" >> $GITHUB_OUTPUT` without trimming.
  process.stdout.write(resolveReleaseBump(currentVersion, parseCommitStream(raw)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
