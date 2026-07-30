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

import { fstatSync, readFileSync, statSync } from 'node:fs';
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
// They contribute nothing on their own, on purpose: a macOS release run
// packages, signs and notarises two architectures, and Apple's notary queue has
// taken anywhere from 30 minutes to over two hours on identical inputs. A
// README typo must not spend that, and must not push a version at every
// installed app that contains nothing for them.
//
// PRECEDENCE, because "nothing" is not unconditional: a breaking marker beats
// this list. `chore!: drop node 18`, or a `docs:` commit with a real
// `BREAKING CHANGE:` footer, resolves `major` (`minor` while the major is still
// 0) — the type is only consulted after isBreaking says no (see bumpForCommit).
// `[skip release]` beats everything, breaking included.
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
// WHERE THE LINE IS DRAWN. Two forms, both MECHANICAL. The rule never tries to
// read intent out of prose:
//
//   1. the marker appears anywhere in the SUBJECT line;
//   2. a BODY line whose ENTIRE content is the marker, allowing an optional
//      leading list bullet (`-`, `*`, `+`), surrounding whitespace and one
//      trailing punctuation character — `[skip release]`, `- [skip release]`,
//      `[skip release].`. Checked on lines that survived fence and blockquote
//      stripping.
//
// Nothing else opts out — `Please [skip release] for this commit.` does NOT.
// That is a DELIBERATE NARROWING, not an oversight: do not widen it back. Two
// rejected alternatives, both tried and both removed:
//
//   REJECTED: "a single-line paragraph that mentions the marker" (round 3). Its
//   meaning depended on LINE WRAPPING — that sentence on one line opted out,
//   the identical sentence wrapped over two did not — and in the other
//   direction a body merely DOCUMENTING the marker ("The literal marker
//   [skip release] suppresses a commit.") opted itself out, so no release was
//   cut. Every widening of a prose rule buys a false positive, and a false
//   positive here is a release the author asked for silently never happening:
//   the exact bug this feature exists to eliminate.
//
//   REJECTED: blanking inline `code spans` before the match. Only ever needed
//   to stop a backticked mention firing the prose rule, and the hand-rolled
//   parser got CommonMark wrong (it did not require the closing backtick run to
//   match the opener's length, so `` `[skip release]` `` blanked partially and
//   the marker leaked back out). Rule 2 makes it unnecessary: on a line reading
//   `` `[skip release]` `` the backticks ARE content, so the line's entire
//   content is not the marker and it structurally cannot fire.
//
// So prose mentioning the marker never opts out, wrapped or not — which is what
// a repo whose own commit messages discuss this feature (see 529b279) needs.
// Both accepted forms are trivial to write on purpose and impossible to hit by
// accident. QUOTING IS ALSO NOT AN OPT-OUT: `> [skip release]` is dropped by
// blockquote stripping before rule 2 sees it, deliberately — a quoted line is
// the author reporting someone else's words, which is how every other rule here
// (breaking footers included) treats one. Write it unquoted.
const SKIP_RELEASE_SUBJECT_RE = /\[skip release\]/i;
const SKIP_RELEASE_OWN_LINE_RE = /^[ \t]*(?:[-*+][ \t]+)?\[skip release\][ \t]*[.,;:!]?[ \t]*$/i;

// A `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer. Both spellings are
// spec-legal aliases. Anchoring to a line start is necessary but nowhere near
// sufficient — see footerBlock for the two things that have to happen first.
const BREAKING_FOOTER_RE = /^BREAKING[ -]CHANGE:/m;

// A line that opens or closes a fenced code block: a run of at least three
// backticks or tildes, indented up to three spaces (CommonMark's limit).
// Group 1 is the run; group 2 is the rest of the line (the info string on an
// opener). The run LENGTH is captured, not just its first three characters:
// round 2 looked at `(```|~~~)` only, so it could not tell a four-backtick
// fence from a three-backtick one and it read a long inline code span as a
// fence. CommonMark's rule is the simplest correct one and it is what this
// implements — see scanBody.
const FENCE_RE = /^ {0,3}((?:`{3,})|(?:~{3,}))(.*)$/;

// A blockquote line: `>` after at most three spaces of indent.
const BLOCKQUOTE_RE = /^ {0,3}>/;

type ScannedLine = {
  text: string;
  // True for the fence delimiters themselves and everything between them.
  fenced: boolean;
  // True for the OPENING delimiter only. Per CommonMark a code fence interrupts
  // a paragraph, so this is where a block boundary is, blank line or not — see
  // bodyParagraphs.
  opensFence: boolean;
  quoted: boolean;
};

// Classify every body line as fenced / quoted / plain, so no rule below can be
// fired by a line that is quoting something rather than saying it.
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
//
// THE TWO COMMONMARK RULES THAT MATTER HERE, both found by review as real
// misreads:
//   - a closing fence must use the SAME character and be AT LEAST AS LONG as
//     the opener. A three-backtick line inside a four-backtick fence is
//     content, not a close; treating it as a close ended the fence early and
//     let a `BREAKING CHANGE:` line that is still inside the outer fence bump
//     to major.
//   - a backtick opener's info string may not contain a backtick. That single
//     clause is what separates a fence from an inline code span: `````code`````
//     on one line has backticks after the run, so it is a paragraph, not an
//     opener. Round 2 opened a fence on it and swallowed the genuine breaking
//     footer that followed — the worse failure of the two, because post-1.0 it
//     silently under-releases a breaking change.
function scanBody(message: string): ScannedLine[] {
  const [subject = ''] = message.split('\n');
  const lines = message.slice(subject.length).split('\n');

  const scanned: ScannedLine[] = [];
  let open: { char: string; length: number } | null = null;
  for (const line of lines) {
    const match = FENCE_RE.exec(line);
    const run = match?.[1];
    const rest = match?.[2] ?? '';
    if (open !== null) {
      // Inside a fence: same character, at least as long, nothing but
      // whitespace after it.
      const closes =
        run !== undefined &&
        run[0] === open.char &&
        run.length >= open.length &&
        rest.trim() === '';
      if (closes) open = null;
      scanned.push({ text: line, fenced: true, opensFence: false, quoted: false });
      continue;
    }
    if (run !== undefined && !(run[0] === '`' && rest.includes('`'))) {
      open = { char: run[0] as string, length: run.length };
      scanned.push({ text: line, fenced: true, opensFence: true, quoted: false });
      continue;
    }
    scanned.push({
      text: line,
      fenced: false,
      opensFence: false,
      quoted: BLOCKQUOTE_RE.test(line),
    });
  }
  return scanned;
}

// The body's plain lines: fenced and quoted ones dropped.
function strippedBodyLines(message: string): string[] {
  return scanBody(message)
    .filter((line) => !line.fenced && !line.quoted)
    .map((line) => line.text);
}

// The body's paragraphs, in the ORIGINAL blank-line structure. A blank line
// inside a fence does not split — the fence is one opaque block — and blocks
// are kept even when every line in them is fenced or quoted, because WHICH
// paragraph is last must be decided before anything is stripped. Round 2 split
// the already-stripped body, so a message whose genuinely-last paragraph was
// entirely a fence or a blockquote lost that paragraph and promoted the one
// before it to "footer" — turning hypothetical breaking text one paragraph up
// into a real major bump.
//
// A BLANK LINE IS NOT THE ONLY BOUNDARY. Per CommonMark a fenced code block
// interrupts a paragraph: an opening fence starts a new block whether or not a
// blank line precedes it, and the first line after the fence ends starts
// another. Splitting on blank lines alone glued a no-blank-line trailing fence
// onto the prose above it, so the fence and that prose were ONE last paragraph;
// stripping the fence out of it left the prose, and `BREAKING CHANGE:` written
// as prose one paragraph up forced a false `major` — but only for authors who
// did not happen to leave a blank line (measured: no-blank `major`, with-blank
// `patch`, otherwise identical input).
function bodyParagraphs(message: string): ScannedLine[][] {
  const paragraphs: ScannedLine[][] = [];
  let current: ScannedLine[] = [];
  const flush = (): void => {
    if (current.length > 0) paragraphs.push(current);
    current = [];
  };

  let previousFenced = false;
  for (const line of scanBody(message)) {
    if (!line.fenced && line.text.trim().length === 0) {
      flush();
      previousFenced = false;
      continue;
    }
    if (line.opensFence || (previousFenced && !line.fenced)) flush();
    current.push(line);
    previousFenced = line.fenced;
  }
  flush();
  return paragraphs;
}

// The message's footer block — the last paragraph of the body, with its fenced
// and quoted lines then removed. Both halves are needed for breaking detection
// and neither is redundant: stripping alone still lets a mid-body
// `BREAKING CHANGE:` line in a prose paragraph count, and the last-paragraph
// rule alone does not help when the fence IS the last paragraph. Stripping
// happens strictly INSIDE the chosen paragraph, never before the choice.
function footerBlock(message: string): string {
  const paragraphs = bodyParagraphs(message);
  const last = paragraphs[paragraphs.length - 1];
  if (last === undefined) return '';
  return last
    .filter((line) => !line.fenced && !line.quoted)
    .map((line) => line.text)
    .join('\n');
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
  if (SKIP_RELEASE_SUBJECT_RE.test(subject)) return true;
  // Line by line, no paragraph grouping and no inline-code parsing: rule 2 is
  // about one line's entire content, so neither is needed.
  return strippedBodyLines(message).some((line) => SKIP_RELEASE_OWN_LINE_RE.test(line));
}

// Every line-oriented rule below — the subject split, the paragraph split, the
// footer match, the marker match, the fence tracker — is written against `\n`.
// A commit authored on Windows arrives with `\r\n` and, before this, every one
// of them silently failed: a `\r` rode along at the end of each line, so
// `[skip release]\r` was not a line of its own (a Windows author's opt-out was
// ignored and a signed, notarised, two-architecture build was cut anyway) and
// a `BREAKING CHANGE:\r` paragraph in mid-body prose became the footer.
//
// Normalizing ONCE, here, is deliberate. Sprinkling `\r?` through the
// individual regexes fixes whichever ones you remember and leaves the rest —
// and completeness is not checkable by reading them. After this line the rest
// of the module can assume LF, and that assumption is provable rather than
// hoped for. Lone `\r` (classic Mac line endings, and what a stray carriage
// return in a pasted body looks like) is normalized too.
function normalizeEol(message: string): string {
  return message.replace(/\r\n?/g, '\n');
}

function bumpForCommit(raw: string, currentMajor: number): ReleaseBump {
  const message = normalizeEol(raw);
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

// SemVer 2.0.0, the published grammar (semver.org's own recommended regex,
// minus its named capture groups). Not a loose approximation: the previous
// `\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?...` accepted `01.2.3`, `1.2.3-alpha..1`,
// `1.2.3+build..5`, `1.2.3-01` and `1.2.3-.`, none of which are versions, while
// the comment claimed the suffix was "legal". The CLI is the trust boundary for
// a `package.json` version nobody validated, so it enforces the real grammar
// rather than a shape that merely looks like one:
//   - core numbers are `0` or a non-zero-leading run of digits;
//   - a pre-release is dot-separated identifiers, each non-empty, and a numeric
//     one may not have a leading zero;
//   - build metadata is dot-separated non-empty alphanumeric-or-hyphen runs.
// `0.2.0-beta.1` — a pre-release, which is what the manual workflow_dispatch
// path actually cuts — stays accepted; that is the reason a suffix is allowed at
// all. Build metadata (`1.0.0-rc.1+build.5`) is accepted here too because the
// published grammar allows it, NOT because the manual path can produce it: that
// path's own preflight regex has no `+` branch and rejects build metadata
// outright.
//
// THE TWO GRAMMARS DISAGREE ON MALFORMED INPUT, and that is pre-existing rather
// than introduced by this branch. release.yml's preflight
// `^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$` predates the resolver: it is
// LOOSER on illegal suffixes (it accepts `01.2.3`, `1.2.3-alpha..1`, `1.2.3-01`,
// `1.2.3-.`, all of which this CLI exits 2 on) and STRICTER on build metadata
// (it rejects `+build.5`, which this CLI accepts). Deliberately left alone —
// changing what the manual path accepts is a separate decision from validating
// what the automatic path reads out of package.json.
const VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

// WHO VALIDATES: the CLI, not the pure function.
//
// resolveReleaseBump stays total — every string in, one of four words out —
// because it is called directly by ~40 tests and by any future caller that has
// already validated, and because throwing from it would turn a bad version
// into an unhandled rejection somewhere instead of a diagnosable exit code.
// Its leniency is documented at the currentMajor line below.
//
// The CLI is the trust boundary: it is the thing a workflow hands an
// unvalidated `package.json` version to, so it rejects a version that does not
// parse rather than answering confidently about garbage.
export function isValidVersion(version: string): boolean {
  return VERSION_RE.test(version);
}

export function resolveReleaseBump(currentVersion: string, commitMessages: string[]): ReleaseBump {
  // Only the major matters, and only for the pre-1.0 breaking rule. A version
  // this function cannot parse is treated as pre-1.0 — a deliberate, and
  // deliberately unreachable-from-the-CLI, fallback: see isValidVersion above
  // for why the rejection lives in main() instead of here. It matters because
  // pre-1.0 downgrades a breaking change from `major` to `minor`, so a silent
  // fallback on garbage is a silently wrong release; main() refuses first.
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
//   - EXACTLY ONE leading newline on every segment but the first. `git log`
//     separates entries with a newline of its own, so the byte stream is
//     really `<message>\0\n<message>\0\n`, and the split leaves that separator
//     at the head of the next segment. Left in, it makes every commit except
//     the newest look like it has an empty subject line — which silently
//     reduced an entire range to "whatever the newest commit was" (found by
//     driving the workflow's extracted shell against a real two-commit range:
//     a `feat` behind a `chore` resolved to the chore's answer, not `minor`).
//
//     BOTH halves of that sentence are load-bearing and round 2 got both
//     wrong. It stripped `^\n+` from EVERY segment, first included, and a
//     commit message CAN begin with a blank line: `git commit
//     --cleanup=verbatim` keeps one, and `%B` hands it back byte for byte
//     (reproduced with a real repo, not assumed). Stripping greedily promoted
//     that message's first body line to its subject, so a commit whose body
//     read `docs: ...` under an empty subject resolved `none` instead of the
//     documented `patch` — a shipped change reported as nothing to release.
//     One newline belongs to the delimiter; every newline after it belongs to
//     the message.
export function parseCommitStream(raw: string): string[] {
  const parts = raw
    .split('\0')
    // Index 0 has no delimiter in front of it, so it is never touched.
    .map((part, index) => (index === 0 ? part : part.replace(/^\n/, '')));
  if (parts[parts.length - 1]?.trim() === '') parts.pop();
  return parts.filter((part) => part.trim().length > 0);
}

const USAGE =
  'usage: git log --format=%B%x00 <range> | node --import tsx scripts/resolve-release-bump.ts <currentVersion>';

// How long to keep retrying an EAGAIN before calling it a failure. See
// readStdin: EAGAIN is the one stdin error that is not a real error.
const EAGAIN_RETRY_MS = 20;
const EAGAIN_RETRY_LIMIT = 100; // ~2s total

// Read all of fd 0, or throw.
//
// fd 0 read synchronously: the input is a git log, bounded by one release
// cycle's worth of commits, and sync keeps the exit-code discipline simple.
//
// Empty stdin and a broken stdin are DIFFERENT ANSWERS and this is where they
// get separated. Empty is legitimate — no commits since the tag — and resolves
// to `none`. A read failure is not: it used to be swallowed into `raw = ''`,
// which made the CLI print `none` and exit 0, so the workflow ended green
// having shipped nothing and said nothing. Silent no-release is the exact
// failure mode this feature exists to eliminate, so a failed read now exits
// non-zero and the step fails loudly.
//
// The two failures worth distinguishing:
//   - a closed fd (`exec 0<&-`). This never reaches the catch below: node
//     opens /dev/null over any missing stdio descriptor before user code runs,
//     so the read succeeds and returns ''. Measured, not assumed — with fd 0
//     closed, fstat(0) reports the same character device and rdev as
//     stat('/dev/null'). It is therefore indistinguishable in-process from an
//     explicit `< /dev/null`, and stdinIsDevNull below rejects both: neither
//     is ever a legitimate commit stream, and answering `none` to one is the
//     silent-no-release bug. An empty pipe and an empty real file — the two
//     shapes a legitimately empty range actually arrives as — are untouched.
//   - EAGAIN, a pipe left in non-blocking mode by the parent process. Node
//     surfaces this from a sync read on fd 0 even though the writer is alive
//     and data is still coming; treating it as terminal would fail runs whose
//     input was fine. It is the one case that is retried, bounded, and only
//     escalated if the fd is still not readable after ~2s.
// Anything else (EIO, EISDIR, ...) is terminal too: it means the input is not
// something this process can read, which is never "nothing to release".
// True when fd 0 is /dev/null — either redirected there or, identically, node
// standing in for a descriptor the caller closed. Any failure to stat is
// answered `false`: an unknown fd is given the benefit of the doubt rather than
// failing a release run over a stat.
function stdinIsDevNull(): boolean {
  try {
    const stdin = fstatSync(0);
    if (!stdin.isCharacterDevice()) return false;
    return stdin.rdev === statSync('/dev/null').rdev;
  } catch {
    return false;
  }
}

function readStdin(): string {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return readFileSync(0, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EAGAIN' || attempt >= EAGAIN_RETRY_LIMIT) throw error;
      // Sync sleep: the read itself is sync, so there is no event loop turn to
      // yield to here.
      Atomics.wait(sleeper, 0, 0, EAGAIN_RETRY_MS);
    }
  }
}

function main(argv: string[]): void {
  if (argv.length !== 1) {
    console.error(USAGE);
    process.exit(2);
  }
  const [currentVersion] = argv as [string];
  // Same class of error as a missing argument, so the same exit code: the
  // caller passed something this CLI cannot act on.
  if (!isValidVersion(currentVersion)) {
    console.error(
      `resolve-release-bump: not a MAJOR.MINOR.PATCH version: ${JSON.stringify(currentVersion)}`,
    );
    console.error(USAGE);
    process.exit(2);
  }

  if (stdinIsDevNull()) {
    console.error(
      'resolve-release-bump: stdin is /dev/null (closed or redirected there), not a commit ' +
        'stream. This is NOT "nothing to release" — refusing to answer.',
    );
    process.exit(1);
  }

  let raw: string;
  try {
    raw = readStdin();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    console.error(
      `resolve-release-bump: could not read commit messages from stdin (${code}). ` +
        'This is NOT "nothing to release" — refusing to answer.',
    );
    process.exit(1);
    return;
  }
  // Exactly the word, no trailing newline, so the workflow can use it raw in
  // `echo "bump=$(...)" >> $GITHUB_OUTPUT` without trimming.
  process.stdout.write(resolveReleaseBump(currentVersion, parseCommitStream(raw)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
