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
// bodies, fenced code that quotes a `BREAKING CHANGE:` line, `[skip release]`
// opt-outs, unparseable subjects) and a bug in them either ships a release
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

// The author's opt-out. It is judged PER COMMIT, not per push: a commit
// carrying it contributes nothing, exactly like a `docs:` commit, and the
// range still decides the outcome. That distinction is the whole point.
// release.yml used to check this marker on the head commit only and exit the
// run, which meant a `[skip release]` merge landing on top of an unreleased
// `feat` suppressed the feat as well — the feature stayed unreleased until
// some unrelated later push happened along. Scoped to the commit, the marker
// can only ever suppress its own commit.
//
// WHERE IT COUNTS: in the subject, or on a line of its own in the body. NOT
// anywhere in the message, for the same reason `BREAKING CHANGE:` is not
// matched anywhere (see footerBlock): this repo's bodies are long enough to
// DISCUSS the marker in prose. Commit 529b279's body does exactly that, and an
// anywhere-match read that feat as opted out — verified against real history,
// not hypothesised. Fenced and quoted lines are stripped before the
// line-of-its-own check, so a marker inside an example cannot fire either.
const SKIP_RELEASE_ANYWHERE_RE = /\[skip release\]/i;
const SKIP_RELEASE_OWN_LINE_RE = /^[ \t]*\[skip release\][ \t]*$/i;

// A `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer. Both spellings are
// spec-legal aliases. Anchoring to a line start is necessary but nowhere near
// sufficient — see footerBlock for the two things that have to happen first.
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/m;

// Lines that open or close a fenced code block: ``` or ~~~, indented up to
// three spaces (CommonMark's limit).
const FENCE_RE = /^ {0,3}(```|~~~)/;

// A blockquote line: `>` after at most three spaces of indent.
const BLOCKQUOTE_RE = /^ {0,3}>/;

// The body's lines with fenced code blocks and blockquotes removed, so no rule
// below can be fired by a line that is quoting something rather than saying it.
//
// A line start inside a ``` fence is still a line start, so an anchored regex
// alone matches a commit that merely DOCUMENTS the string:
//
//   fix(api): document parser
//
//   ```text
//   BREAKING CHANGE: example only
//   ```
//
// which forced a breaking bump on a commit that breaks nothing. Bodies in this
// repo are long enough to quote things, so this is a real shape, not a
// theoretical one. An unterminated fence swallows the rest of the message,
// which is the cautious direction: nothing after it can force a release.
function bodyLines(message: string): string[] {
  const [subject = ''] = message.split('\n');
  const lines = message.slice(subject.length).split('\n');

  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fence !== null) {
      // Inside a fence: only a fence of the same kind closes it.
      if (fenceMatch?.[1] === fence) fence = null;
      continue;
    }
    if (fenceMatch?.[1] !== undefined) {
      fence = fenceMatch[1];
      continue;
    }
    if (BLOCKQUOTE_RE.test(line)) continue;
    kept.push(line);
  }
  return kept;
}

// The message's footer block — the last blank-line-separated paragraph of the
// stripped body. Both this and the stripping above are needed for breaking
// detection and neither is redundant: stripping fences alone still lets a
// mid-body `BREAKING CHANGE:` line in a prose paragraph count, and the
// last-paragraph rule alone does not help when the fence IS the last
// paragraph, which is exactly the shape the review found.
function footerBlock(message: string): string {
  // Blank lines left behind by a stripped fence must not become the "last
  // paragraph", so empty paragraphs are discarded and the last surviving one
  // wins.
  const paragraphs = bodyLines(message)
    .join('\n')
    .split(/\n[ \t]*\n/)
    .filter((paragraph) => paragraph.trim().length > 0);
  return paragraphs[paragraphs.length - 1] ?? '';
}

function isBreaking(message: string): boolean {
  const [subject = ''] = message.split('\n');
  const match = SUBJECT_RE.exec(subject.trim());
  if (match?.[3] === '!') return true;
  // Only the footer block of the body is searched, so a subject that happens
  // to read `fix: BREAKING CHANGE: ...` is judged by its `!` (or lack of one),
  // and prose or quoted examples elsewhere in the body cannot force a bump.
  return BREAKING_FOOTER_RE.test(footerBlock(message));
}

function isSkipped(message: string): boolean {
  const [subject = ''] = message.split('\n');
  if (SKIP_RELEASE_ANYWHERE_RE.test(subject)) return true;
  return bodyLines(message).some((line) => SKIP_RELEASE_OWN_LINE_RE.test(line));
}

function bumpForCommit(message: string, currentMajor: number): ReleaseBump {
  const [rawSubject = ''] = message.split('\n');
  const subject = rawSubject.trim();
  // An opted-out commit is treated exactly like a `docs:` one: it contributes
  // nothing and does not stop anything else in the range from contributing.
  if (isSkipped(message)) return 'none';
  if (subject.length === 0) {
    // No subject, but content below it — the sloppiest message there is, and
    // by the bias documented further down it must still resolve to `patch`:
    // a real change landed. A message with no content at all cannot reach
    // here through the CLI (parseCommitStream drops whitespace-only segments,
    // which are the trailing-NUL artifact of `git log --format=%B%x00`, not
    // commits), but resolveReleaseBump is called directly by tests too.
    return message.trim().length === 0 ? 'none' : 'patch';
  }
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
// Two artifacts of that framing are removed and nothing else is:
//   - the trailing empty segment after the final NUL;
//   - a leading newline on every segment but the first. `git log` separates
//     entries with a newline of its own, so the byte stream is really
//     `<message>\0\n<message>\0\n`, and the split leaves that separator at the
//     head of the next segment. Left in, it makes every commit except the
//     newest look like it has an empty subject line — which silently reduced
//     an entire range to "whatever the newest commit was" (found by driving
//     the workflow's extracted shell against a real two-commit range: a
//     `feat` behind a `chore` resolved to the chore's answer, not `minor`).
//     Git itself strips leading blank lines from a commit message, so no real
//     message can begin with one and nothing legitimate is lost here.
export function parseCommitStream(raw: string): string[] {
  const parts = raw.split('\0').map((part) => part.replace(/^\n+/, ''));
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
