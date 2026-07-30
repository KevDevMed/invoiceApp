import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isValidVersion, parseCommitStream, resolveReleaseBump } from '../resolve-release-bump';

// Fixtures are shaped like this repo's real history rather than minimal
// one-liners: the subjects are the ones `git log` actually shows (including a
// squash-merge `(#21)` suffix and a multi-part scope), because the bug worth
// catching is a regex that only matches tidy `feat: x` subjects.
const FEAT = 'feat(shell,theme): invert the surfaces, glyph theme toggle in the sidebar (#21)';
const FIX = 'fix(theme): AA-contrast secondary ink, matchMedia race, honest harness';
const DOCS = 'docs: explain the release trigger';
const CHORE = 'chore(deps): bump vitest';
const RELEASE = 'chore(release): 0.1.7';

const CLI = fileURLToPath(new URL('../resolve-release-bump.ts', import.meta.url));

function runCli(currentVersion: string, messages: string[]): string {
  return execFileSync(process.execPath, ['--import', 'tsx', CLI, currentVersion], {
    input: messages.map((m) => `${m}\0`).join(''),
    encoding: 'utf8',
  });
}

// Same, but never throws: returns the exit code and both streams, so the
// rejection paths can be asserted rather than just observed as a throw.
function runCliRaw(argv: string[], input: string | Buffer = ''): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...argv], {
    input,
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('resolveReleaseBump', () => {
  it('resolves none for an empty commit list', () => {
    expect(resolveReleaseBump('0.1.7', [])).toBe('none');
  });

  it('resolves none when nothing but docs and chore landed', () => {
    expect(resolveReleaseBump('0.1.7', [DOCS, CHORE])).toBe('none');
  });

  it('resolves none for every non-contributing type', () => {
    for (const type of ['docs', 'chore', 'ci', 'test', 'style', 'build']) {
      expect(resolveReleaseBump('0.1.7', [`${type}: housekeeping`])).toBe('none');
      expect(resolveReleaseBump('0.1.7', [`${type}(scope): housekeeping`])).toBe('none');
    }
  });

  it('resolves patch for a fix', () => {
    expect(resolveReleaseBump('0.1.7', [FIX])).toBe('patch');
  });

  it('resolves patch for types that are neither feat nor non-contributing', () => {
    expect(resolveReleaseBump('0.1.7', ['perf: fewer renders'])).toBe('patch');
    expect(resolveReleaseBump('0.1.7', ['refactor(db): extract migration runner'])).toBe('patch');
    expect(resolveReleaseBump('0.1.7', ['wibble: nobody knows this type'])).toBe('patch');
  });

  it('resolves patch for a subject that is not conventional-commit shaped', () => {
    expect(resolveReleaseBump('0.1.7', ['Merge pull request #14 from KevDevMed/feature'])).toBe(
      'patch',
    );
    expect(resolveReleaseBump('0.1.7', ['wip'])).toBe('patch');
    // A colon alone is not a conventional type — still a real change, so
    // still a patch, never a silent none.
    expect(resolveReleaseBump('0.1.7', ['Revert "feat: something": undo it'])).toBe('patch');
  });

  it('resolves minor for a feat', () => {
    expect(resolveReleaseBump('0.1.7', [FEAT])).toBe('minor');
  });

  it('takes the highest bump when a feat and a fix land together, in either order', () => {
    expect(resolveReleaseBump('0.1.7', [FIX, FEAT, DOCS])).toBe('minor');
    expect(resolveReleaseBump('0.1.7', [FEAT, FIX, DOCS])).toBe('minor');
  });

  it('matches types case-insensitively', () => {
    expect(resolveReleaseBump('0.1.7', ['FEAT: shout'])).toBe('minor');
    expect(resolveReleaseBump('0.1.7', ['Feat(ui): shout'])).toBe('minor');
    expect(resolveReleaseBump('0.1.7', ['DOCS: shout'])).toBe('none');
    expect(resolveReleaseBump('0.1.7', ['Chore: shout'])).toBe('none');
  });

  it('skips this workflow own bump commits entirely', () => {
    expect(resolveReleaseBump('0.1.7', [RELEASE])).toBe('none');
    expect(resolveReleaseBump('0.1.7', [RELEASE, FIX])).toBe('patch');
    // Skipped means skipped: even a bump commit that somehow carries a
    // breaking footer cannot cause a release.
    expect(
      resolveReleaseBump('1.2.3', [`${RELEASE}\n\nBREAKING CHANGE: not really`]),
    ).toBe('none');
  });

  describe('breaking changes', () => {
    const BANG = 'feat(api)!: drop the legacy invoice schema';
    const FOOTER = `refactor(db): rewrite the migration runner

The old runner replayed every migration on boot.

BREAKING CHANGE: databases written by 0.1.x must be re-migrated.`;

    it('resolves minor, not major, while the current major is 0', () => {
      expect(resolveReleaseBump('0.1.7', [BANG])).toBe('minor');
      expect(resolveReleaseBump('0.1.7', [FOOTER])).toBe('minor');
      expect(resolveReleaseBump('0.9.0-beta.1', [BANG])).toBe('minor');
    });

    it('resolves major once the current major is 1 or more', () => {
      expect(resolveReleaseBump('1.0.0', [BANG])).toBe('major');
      expect(resolveReleaseBump('1.0.0', [FOOTER])).toBe('major');
      expect(resolveReleaseBump('2.4.9', [BANG])).toBe('major');
    });

    it('accepts the BREAKING-CHANGE hyphen spelling', () => {
      const hyphen = 'fix(db): tighten the schema\n\nBREAKING-CHANGE: the column is gone.';
      expect(resolveReleaseBump('1.0.0', [hyphen])).toBe('major');
    });

    it('honours the bang on a type that would otherwise contribute nothing', () => {
      expect(resolveReleaseBump('1.0.0', ['chore!: drop node 18 support'])).toBe('major');
    });

    it('ignores BREAKING CHANGE mentioned mid-line in prose', () => {
      const prose = `fix(api): keep the legacy field

This is deliberately not a BREAKING CHANGE: the old field still resolves.`;
      expect(resolveReleaseBump('1.0.0', [prose])).toBe('patch');
    });

    it('ignores a BREAKING CHANGE line inside a fenced code block', () => {
      // A line start inside a fence is still a line start, so an anchored
      // regex alone called this breaking. The fence here is the LAST block of
      // the message, so the footer-block rule does not save it either — only
      // fence-stripping does.
      const fenced = `fix(api): document parser

\`\`\`text
BREAKING CHANGE: example only
\`\`\``;
      expect(resolveReleaseBump('1.2.3', [fenced])).toBe('patch');
      expect(resolveReleaseBump('0.1.7', [fenced])).toBe('patch');
    });

    it('ignores a BREAKING CHANGE line inside a tilde fence or a blockquote', () => {
      const tilde = `fix(api): quote the spec

~~~
BREAKING CHANGE: example only
~~~`;
      const quoted = `fix(api): quote the changelog

> BREAKING CHANGE: what the other project wrote, not us.`;
      expect(resolveReleaseBump('1.2.3', [tilde])).toBe('patch');
      expect(resolveReleaseBump('1.2.3', [quoted])).toBe('patch');
    });

    it('ignores a BREAKING CHANGE line in a body paragraph that is not the footer', () => {
      // Fence-stripping alone would not catch this one: the line is real
      // prose, at a line start, and something else follows it. Only the
      // footer-block rule rejects it.
      const midBody = `fix(api): keep the legacy field

BREAKING CHANGE: is what a lazier version of this commit would have said.

It is not breaking; the old field still resolves.`;
      expect(resolveReleaseBump('1.2.3', [midBody])).toBe('patch');
    });

    it('still honours a genuine footer that is the last block', () => {
      const genuineLast = `refactor(db): rewrite the migration runner

\`\`\`sh
npm run db:migrate
\`\`\`

BREAKING CHANGE: databases written by 0.1.x must be re-migrated.`;
      expect(resolveReleaseBump('1.2.3', [genuineLast])).toBe('major');
      expect(resolveReleaseBump('0.1.7', [genuineLast])).toBe('minor');
      // And the plain body-then-footer shape keeps working.
      expect(resolveReleaseBump('1.2.3', [FOOTER])).toBe('major');
    });

    it('does not close a four-backtick fence on a three-backtick line inside it', () => {
      // H3. Round 2 matched `(```|~~~)` — the first three marker characters
      // only — so the inner ``` ended the fence and the BREAKING line, still
      // inside the OUTER fence, counted. CommonMark: a closing fence must be
      // the same character and at least as long.
      const nested = `fix(api): document the fence rules

\`\`\`\`markdown
\`\`\`
BREAKING CHANGE: example only, still inside the outer fence
\`\`\`
\`\`\`\``;
      expect(resolveReleaseBump('1.2.3', [nested])).toBe('patch');
      expect(resolveReleaseBump('0.1.7', [nested])).toBe('patch');
    });

    it('does not read a long inline code span as a fence', () => {
      // The other half of H3, and the worse direction: round 2 opened a fence
      // on the five-backtick span and never closed it, swallowing the genuine
      // footer — a breaking change silently under-released. CommonMark: a
      // backtick opener's info string may not contain a backtick, so this line
      // is a paragraph.
      const span = `refactor(api): rename the field

The old call was \`\`\`\`\`invoice.total\`\`\`\`\` and is gone.

BREAKING CHANGE: invoice.total is now invoice.amountTotal.`;
      expect(resolveReleaseBump('1.2.3', [span])).toBe('major');
      expect(resolveReleaseBump('0.1.7', [span])).toBe('minor');
    });

    it('does not let stripping the last paragraph promote the one above it', () => {
      // M1. The footer paragraph is chosen from the ORIGINAL paragraph
      // structure; stripping happens inside it. Round 2 stripped first, so the
      // trailing blockquote/fence vanished and the prose above became "last".
      const quotedLast = `fix(api): keep the legacy field

BREAKING CHANGE: is what the reporter thought this was.

> It is not: the old field still resolves. Quoting their words, not ours.`;
      const fencedLast = `fix(api): keep the legacy field

BREAKING CHANGE: is what a lazier version of this commit would have said.

\`\`\`text
still not breaking
\`\`\``;
      expect(resolveReleaseBump('1.2.3', [quotedLast])).toBe('patch');
      expect(resolveReleaseBump('1.2.3', [fencedLast])).toBe('patch');
      expect(resolveReleaseBump('0.1.7', [quotedLast])).toBe('patch');
    });

    it('treats a trailing fence as its own block with or without a blank line', () => {
      // ROUND 4, finding 4. A code fence interrupts a paragraph (CommonMark),
      // but the split was on blank lines alone, so the no-blank shape glued the
      // fence onto the prose above; that combined block became the footer,
      // stripping the fence left the BREAKING prose, and the bump was a false
      // `major`. Measured before the fix: no-blank `major`, with-blank `patch`,
      // on otherwise identical input.
      const noBlank = `fix(api): keep the legacy field

BREAKING CHANGE: is what a lazier version of this commit would have said.
\`\`\`text
still not breaking
\`\`\``;
      const withBlank = `fix(api): keep the legacy field

BREAKING CHANGE: is what a lazier version of this commit would have said.

\`\`\`text
still not breaking
\`\`\``;
      expect(resolveReleaseBump('1.2.3', [noBlank])).toBe('patch');
      expect(resolveReleaseBump('1.2.3', [withBlank])).toBe('patch');
      // The mirror case: prose immediately AFTER a closing fence is its own
      // block too, so a genuine footer written without a blank line still wins.
      const footerAfterFence = `refactor(api): rename the field

\`\`\`text
example
\`\`\`
BREAKING CHANGE: invoice.total is now invoice.amountTotal.`;
      expect(resolveReleaseBump('1.2.3', [footerAfterFence])).toBe('major');
    });

    it('keeps an unterminated fence swallowing everything after it', () => {
      const unterminated = `fix(api): document parser

\`\`\`text
BREAKING CHANGE: example only, fence never closed`;
      expect(resolveReleaseBump('1.2.3', [unterminated])).toBe('patch');
    });
  });

  describe('CRLF line endings', () => {
    // H2. One root cause, several symptoms: every line rule in the resolver is
    // written against \n, so before normalization a `\r` rode along at the end
    // of each line and none of them matched. The first case below is the sharp
    // one — a Windows author's opt-out ignored and a signed, notarised,
    // two-architecture build cut anyway.
    it('honours [skip release] written with CRLF', () => {
      expect(resolveReleaseBump('0.1.7', ['feat: windows optout\r\n\r\n[skip release]\r\n'])).toBe(
        'none',
      );
      expect(resolveReleaseBump('0.1.7', ['fix: internal\r\n\r\n[skip release]\r\n'])).toBe('none');
      expect(resolveReleaseBump('0.1.7', ['\r\n[skip release]\r\n'])).toBe('none');
    });

    it('does not read mid-body CRLF prose as a breaking footer', () => {
      const crlf = 'fix: windows\r\n\r\nBREAKING CHANGE: discussed only\r\n\r\nLater paragraph.\r\n';
      expect(resolveReleaseBump('1.2.3', [crlf])).toBe('patch');
    });

    it('still honours a genuine CRLF footer, fence and blockquote', () => {
      expect(
        resolveReleaseBump('1.2.3', ['refactor: x\r\n\r\nBREAKING CHANGE: really.\r\n']),
      ).toBe('major');
      expect(
        resolveReleaseBump('1.2.3', ['fix: x\r\n\r\n```text\r\nBREAKING CHANGE: quoted\r\n```\r\n']),
      ).toBe('patch');
      expect(resolveReleaseBump('1.2.3', ['fix: x\r\n\r\n> BREAKING CHANGE: theirs\r\n'])).toBe(
        'patch',
      );
    });

    it('normalizes a lone CR too', () => {
      expect(resolveReleaseBump('0.1.7', ['feat: mac classic\r\r[skip release]\r'])).toBe('none');
    });
  });

  describe('[skip release]', () => {
    it('makes the commit carrying it contribute nothing', () => {
      expect(resolveReleaseBump('0.1.7', [`${FIX}\n\n[skip release]`])).toBe('none');
      expect(resolveReleaseBump('0.1.7', [`${FEAT} [skip release]`])).toBe('none');
      // Even a breaking one: the marker is the author saying "not this push".
      expect(resolveReleaseBump('1.2.3', ['feat(api)!: drop it [skip release]'])).toBe('none');
    });

    it('does NOT suppress an earlier releasable commit in the same range', () => {
      // The finding this rule exists for. PR A carries a feat and merges; PR B
      // carries [skip release] and merges before A's run pushes. The range
      // still contains A's unreleased feature, so it must still be released.
      expect(resolveReleaseBump('0.1.7', [FEAT, `${DOCS}\n\n[skip release]`])).toBe('minor');
      expect(resolveReleaseBump('0.1.7', [`${DOCS}\n\n[skip release]`, FEAT])).toBe('minor');
      expect(resolveReleaseBump('0.1.7', [FIX, 'chore: tidy [skip release]'])).toBe('patch');
    });

    it('resolves none when the marker is the only thing in the range', () => {
      expect(resolveReleaseBump('0.1.7', ['chore: tidy [skip release]'])).toBe('none');
    });

    it('does not fire on a body that merely discusses the marker', () => {
      // Real history: commit 529b279's body explains what `[skip release]`
      // does. An anywhere-in-the-message match read that feat as opted out and
      // resolved the real v0.1.7..HEAD range to patch instead of minor.
      const discusses = `${FEAT}

The resolver treats a commit carrying \`[skip release]\` as contributing
nothing, so a marker in prose like this one must not fire.`;
      expect(resolveReleaseBump('0.1.7', [discusses])).toBe('minor');
    });

    it('fires on a body line whose entire content is the marker', () => {
      // Rule 2, the only body form. A bullet, surrounding whitespace and one
      // trailing punctuation character are allowed; nothing else is.
      expect(resolveReleaseBump('0.1.7', [`${FIX}\n\n- [skip release]`])).toBe('none');
      expect(resolveReleaseBump('0.1.7', [`${FIX}\n\n* [skip release]`])).toBe('none');
      expect(resolveReleaseBump('0.1.7', [`${FIX}\n\n+ [skip release]`])).toBe('none');
      expect(resolveReleaseBump('0.1.7', [`${FIX}\n\n  [skip release].`])).toBe('none');
      // And it does not care where in the body the line sits, or how many
      // other lines share its paragraph.
      expect(
        resolveReleaseBump('0.1.7', [`${FIX}\n\nNo need to ship this one.\n[skip release]`]),
      ).toBe('none');
    });

    it('fires on the marker anywhere in the subject', () => {
      // Rule 1.
      expect(resolveReleaseBump('0.1.7', ['feat: thing [skip release]'])).toBe('none');
      expect(resolveReleaseBump('0.1.7', ['[skip release] fix: thing'])).toBe('none');
    });

    it('never fires on prose, whatever the line wrapping', () => {
      // ROUND 4, THE DESIGN FIX. Round 3 also matched "a single-line paragraph
      // that mentions the marker", which made the rule's meaning depend on
      // where the author's editor wrapped the line — and made a commit that
      // merely DOCUMENTED the marker opt itself out, so no release was cut.
      // Both directions are now the same answer. The narrowing is deliberate:
      // widening this back reintroduces the silent-no-release bug.
      const oneLine = `fix: document parser

The literal marker [skip release] suppresses a commit.`;
      const wrapped = `fix: internal

Please [skip release] for this commit;
it changes internal tooling only.`;
      const oneLineRequest = `fix: internal

Please [skip release] for this commit.`;
      expect(resolveReleaseBump('0.1.7', [oneLine])).toBe('patch');
      expect(resolveReleaseBump('0.1.7', [wrapped])).toBe('patch');
      expect(resolveReleaseBump('0.1.7', [oneLineRequest])).toBe('patch');

      // Copied from 529b279's real body: backticked on its line 51, bare
      // inside a wrapped paragraph on its line 70.
      const backticked = `${FEAT}

Three conditions end the run green with nothing pushed: a resolved bump of
\`none\`, a head commit that is already \`chore(release):\`, or \`[skip release]\`
in the head message.`;
      const bareInProse = `${FEAT}

The resolve step's shell was exercised locally through all four outcomes
(minor, chore(release) skip, [skip release] skip, docs-only none) and the
YAML parsed with js-yaml.`;
      expect(resolveReleaseBump('0.1.7', [backticked])).toBe('minor');
      expect(resolveReleaseBump('0.1.7', [bareInProse])).toBe('minor');
    });

    it('does not fire on a backticked marker, with no code-span parser', () => {
      // H1 in round 3 was a broken hand-rolled code-span regex (it did not
      // require the closing backtick run to match the opener, so the blanking
      // was partial and the marker leaked out). Rule 2 removes the need for one
      // entirely: on a line reading `` `[skip release]` `` the backticks ARE
      // content, so the line's entire content is not the marker.
      expect(resolveReleaseBump('0.1.7', [`${FEAT}\n\nThe marker \`[skip release]\` is docs.`])).toBe(
        'minor',
      );
      expect(resolveReleaseBump('0.1.7', [`${FEAT}\n\n\`[skip release]\``])).toBe('minor');
      expect(resolveReleaseBump('0.1.7', [`${FEAT}\n\n\`\`[skip release]\`\``])).toBe('minor');
    });

    it('does not fire on a marker inside a fence, or quoted', () => {
      // Quoting the marker is NOT an opt-out, and that is a decision rather
      // than an accident: a blockquote is the author reporting someone else's
      // words, which is how every other rule here treats one.
      const fenced = `${FIX}

\`\`\`
[skip release]
\`\`\``;
      const quoted = `${FIX}\n\n> [skip release]`;
      expect(resolveReleaseBump('0.1.7', [fenced])).toBe('patch');
      expect(resolveReleaseBump('0.1.7', [quoted])).toBe('patch');
    });
  });

  describe('an empty subject with a body', () => {
    it('resolves patch, because a real change landed with a sloppy message', () => {
      expect(resolveReleaseBump('0.1.7', ['\nbody describes shipped fix'])).toBe('patch');
      expect(resolveReleaseBump('0.1.7', ['   \n\nbody describes shipped fix'])).toBe('patch');
    });

    it('resolves none for a message with no content at all', () => {
      // Distinct from the case above on purpose: a whitespace-only segment is
      // the trailing-NUL artifact of `git log --format=%B%x00`, not a commit,
      // and parseCommitStream drops it before the resolver ever sees it.
      expect(resolveReleaseBump('0.1.7', [''])).toBe('none');
      expect(resolveReleaseBump('0.1.7', ['\n \n'])).toBe('none');
      expect(parseCommitStream('\n \n\0')).toEqual([]);
      // ...but a segment with content IS a commit and survives the parse.
      // Nothing is stripped from the FIRST segment: there is no delimiter in
      // front of it, so its leading newline is the message's own (see the
      // --cleanup=verbatim test below).
      expect(parseCommitStream('\nbody describes shipped fix\0')).toEqual([
        '\nbody describes shipped fix',
      ]);
    });

    it('still respects [skip release] in a subject-less message', () => {
      expect(resolveReleaseBump('0.1.7', ['\nbody, opted out\n\n[skip release]'])).toBe('none');
    });
  });
});

describe('parseCommitStream', () => {
  it('splits NUL-delimited messages and drops the trailing empty segment', () => {
    expect(parseCommitStream(`${FEAT}\0${FIX}\0`)).toEqual([FEAT, FIX]);
  });

  it('resolves none for empty or whitespace-only input', () => {
    expect(parseCommitStream('')).toEqual([]);
    expect(parseCommitStream('\0')).toEqual([]);
    expect(parseCommitStream('\n\n')).toEqual([]);
  });

  it('strips the entry separator git puts after each NUL', () => {
    // The exact bytes `git log --format=%B%x00` emits for two commits: the
    // message, a NUL, then git's own newline between entries. Without the
    // strip, every commit but the newest reads as having an empty subject and
    // the whole range collapses to the newest commit's answer.
    const raw = `${CHORE}\n\n[skip release]\n\0\n${FEAT}\n\0\n`;
    expect(parseCommitStream(raw)).toEqual([`${CHORE}\n\n[skip release]\n`, `${FEAT}\n`]);
    expect(resolveReleaseBump('0.1.7', parseCommitStream(raw))).toBe('minor');
  });

  // DO NOT DELETE THESE AS "REDUNDANT" NEXT TO THE HAND-JOINED FIXTURES ABOVE.
  //
  // Every other test in this file builds its stream as `messages.join('\0')` —
  // and that fixture is exactly what the shipped bug was blind to. Git does
  // not emit `<message>\0<message>\0`; `--format=%B%x00` emits
  // `<message>\0\n<message>\0\n`, an LF AFTER each NUL, because the format's
  // per-entry newline lands past the NUL. A hand-joined fixture omits that LF,
  // so every hand-built multi-commit test passed while the real range silently
  // discarded every commit but the newest. The three outcomes below are the
  // three the bug broke; they are written with git's real byte framing on
  // purpose. See also the real-git integration test at the bottom of the file,
  // which is what proves the framing string above is still what git emits.
  describe('with git real byte framing (LF after each NUL)', () => {
    // Newest commit first, exactly like `git log`.
    const framed = (...messages: string[]): string =>
      messages.map((message) => `${message}\0\n`).join('');

    it('resolves minor when the newest is docs and an older feat is still in range', () => {
      expect(resolveReleaseBump('0.1.7', parseCommitStream(framed(DOCS, FEAT)))).toBe('minor');
    });

    it('resolves minor when the newest is a fix and an older feat is in range', () => {
      expect(resolveReleaseBump('0.1.7', parseCommitStream(framed(FIX, FEAT)))).toBe('minor');
    });

    it('resolves none when every commit in range is docs or chore', () => {
      expect(resolveReleaseBump('0.1.7', parseCommitStream(framed(DOCS, CHORE, DOCS)))).toBe(
        'none',
      );
    });
  });

  it('keeps a multi-line body whole, blank lines and quotes included', () => {
    const message = `feat(cli): accept a "quoted" flag

Body line with 'single', "double" and \`backtick\` quotes, plus $(echo hi).

Trailing paragraph after a blank line.`;
    expect(parseCommitStream(`${message}\0`)).toEqual([message]);
  });
});

describe('CLI', () => {
  it('prints exactly the resolved word, with no trailing newline', () => {
    expect(runCli('0.1.7', [FEAT, FIX])).toBe('minor');
    expect(runCli('0.1.7', [DOCS])).toBe('none');
  });

  it('resolves none on empty stdin', () => {
    expect(runCli('0.1.7', [])).toBe('none');
  });

  it('survives a commit message full of quotes, blank lines and shell syntax', () => {
    // The precise hazard the NUL framing exists for: this body would break
    // any argv or newline-delimited transport through a shell.
    const nasty = `fix(pdf): escape "quotes" in the invoice footer

The footer ran through \`printf '%s'\` and $(basename "$0") ate the value.

  * a blank line above and below
  * a lone " here

BREAKING CHANGE: nope, this line is quoted prose only when it is not at
the start of a line.`;
    expect(runCli('1.0.0', [nasty, DOCS])).toBe('major');
    expect(runCli('0.1.7', [nasty, DOCS])).toBe('minor');
  });

  describe('version argument validation', () => {
    it('rejects a version that is not MAJOR.MINOR.PATCH shaped', () => {
      // The finding: `banana` fell through to major 0, and major 0 downgrades
      // a breaking change from `major` to `minor`. Answering `minor`
      // confidently on garbage is one refactor away from shipping the wrong
      // release, so the CLI refuses instead.
      const breaking = 'refactor(db): x\n\nBREAKING CHANGE: real';
      for (const bad of [
        'banana',
        'v1.2.3',
        '1.2',
        '1.2.3.4',
        '',
        '1.2.x',
        // L1: shapes the loose regex waved through. Leading zeros in a core
        // number and empty or zero-led dot-separated identifiers are not
        // SemVer, and the CLI answered `minor` on every one of them.
        '01.2.3',
        '1.02.3',
        '1.2.03',
        '1.2.3-alpha..1',
        '1.2.3+build..5',
        '1.2.3-01',
        '1.2.3-.',
        '1.2.3+',
        '1.2.3-',
      ]) {
        const result = runCliRaw([bad], `${breaking}\0\n`);
        expect(result.status, `version ${JSON.stringify(bad)}`).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('not a MAJOR.MINOR.PATCH version');
      }
    });

    it('accepts a pre-release version, because the manual path cuts those', () => {
      const result = runCliRaw(['0.2.0-beta.1'], `${FEAT}\0\n`);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('minor');
      expect(result.stderr).toBe('');
      // Build metadata is legal semver too, and a breaking change at a 1.x
      // pre-release still has to read as major.
      expect(runCliRaw(['1.0.0-rc.1+build.5'], 'feat(api)!: drop it\0\n').stdout).toBe('major');
    });

    it('agrees with the exported predicate', () => {
      expect(isValidVersion('0.1.7')).toBe(true);
      expect(isValidVersion('0.2.0-beta.1')).toBe(true);
      expect(isValidVersion('10.20.30')).toBe(true);
      expect(isValidVersion('banana')).toBe(false);
      expect(isValidVersion('v0.2.0')).toBe(false);
      // The suffixes the manual path cuts stay legal...
      expect(isValidVersion('1.0.0-rc.1+build.5')).toBe(true);
      expect(isValidVersion('1.0.0-0.3.7')).toBe(true);
      expect(isValidVersion('1.0.0-alpha-1')).toBe(true);
      expect(isValidVersion('1.0.0+21AF26D3--117B344092BD')).toBe(true);
      // ...and the malformed ones do not.
      expect(isValidVersion('01.2.3')).toBe(false);
      expect(isValidVersion('1.2.3-alpha..1')).toBe(false);
      expect(isValidVersion('1.2.3+build..5')).toBe(false);
      expect(isValidVersion('1.2.3-01')).toBe(false);
      expect(isValidVersion('1.2.3-.')).toBe(false);
      // The pure resolver stays total on purpose — validation is the CLI's
      // job, not its caller's. Documented at isValidVersion.
      expect(resolveReleaseBump('banana', [FIX])).toBe('patch');
    });
  });

  describe('stdin read failures', () => {
    it('fails loudly on a closed stdin instead of reporting nothing to release', () => {
      // `none` + exit 0 on a broken read is the silent-no-release failure mode
      // this whole feature exists to eliminate: the workflow ends green having
      // shipped nothing.
      const result = spawnSync(
        'bash',
        ['-c', `exec 0<&-; exec "$0" --import tsx "$1" 0.1.7`, process.execPath, CLI],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('stdin is /dev/null');
      expect(result.stderr).toContain('NOT "nothing to release"');
    });

    it('fails the same way on an explicit /dev/null redirect', () => {
      // Node opens /dev/null over a closed fd 0 before user code runs, so this
      // and the closed-fd case above are the same process state. Neither is a
      // commit stream.
      const result = spawnSync(
        'bash',
        ['-c', `exec "$0" --import tsx "$1" 0.1.7 < /dev/null`, process.execPath, CLI],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('stdin is /dev/null');
    });

    it('still resolves none for genuinely empty stdin', () => {
      // The other half of the distinction: an empty PIPE is legitimate — the
      // range really had no commits.
      const result = runCliRaw(['0.1.7'], '');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('none');
      expect(result.stderr).toBe('');
      // And an empty real file, which is what release.yml actually redirects
      // in (`< /tmp/release-commits.bin`) when the range is empty.
      const emptyFile = join(mkdtempSync(join(tmpdir(), 'release-bump-empty-')), 'commits.bin');
      writeFileSync(emptyFile, '');
      const fromFile = spawnSync(
        'bash',
        ['-c', `exec "$0" --import tsx "$1" 0.1.7 < "$2"`, process.execPath, CLI, emptyFile],
        { encoding: 'utf8' },
      );
      expect(fromFile.status).toBe(0);
      expect(fromFile.stdout).toBe('none');
      rmSync(emptyFile, { force: true });
    });

    // NOT TESTED: EAGAIN. Reproducing it needs stdin to be a pipe left in
    // non-blocking mode by the parent, which Node's own child_process cannot
    // set up (it hands children blocking descriptors) and which is racy by
    // nature — the retry loop exists for a condition that clears on its own,
    // so a deterministic assertion on it is not available here.
  });
});

// The end of the framing chain: everything above trusts a hard-coded `\0\n`,
// and this is the test that checks git still emits it. If git ever changes the
// format, this fails and the hand-written fixtures above become wrong together.
describe('real git integration', () => {
  let repo: string;

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'release-bump-git-'));
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    // Oldest first. The ranges below slice this so each of the three broken
    // outcomes gets a real commit range.
    for (const message of ['feat: deep', 'fix: middle', 'docs: newest', CHORE, 'docs: also']) {
      git('commit', '-q', '--allow-empty', '-m', message);
    }
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function logBytes(...range: string[]): Buffer {
    return execFileSync('git', ['-C', repo, 'log', '--format=%B%x00', ...range]);
  }

  it('really does emit an LF after every NUL', () => {
    const raw = logBytes('HEAD~3');
    // Two commits in this range, so two records, each `<message>\0\n`.
    expect(raw.toString('utf8')).toBe('fix: middle\n\0\nfeat: deep\n\0\n');
    expect(raw.includes(Buffer.from([0x00, 0x0a]))).toBe(true);
  });

  it('resolves minor when the newest is docs and an older feat is in range', () => {
    // HEAD~2 == `docs: newest`; the range is docs, fix, feat.
    const result = runCliRaw(['0.1.7'], logBytes('HEAD~2'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('minor');
  });

  it('resolves minor when the newest is a fix and an older feat is in range', () => {
    const result = runCliRaw(['0.1.7'], logBytes('HEAD~3'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('minor');
  });

  it('keeps a genuine leading blank line in the newest message', () => {
    // H1. `git commit --cleanup=verbatim` preserves a leading blank line and
    // `%B` hands it back byte for byte, so the "git strips those" claim round 2
    // relied on is false. Stripping `^\n+` promoted the body's first line to
    // the subject: the `docs:` line below became the subject and the commit
    // resolved `none` — a shipped change reported as nothing to release. The
    // documented answer for an empty subject WITH content is `patch`.
    const messageFile = join(repo, 'verbatim-message.txt');
    writeFileSync(messageFile, '\ndocs: body content is real\n');
    git(
      'commit',
      '-q',
      '--allow-empty',
      '--allow-empty-message',
      '--cleanup=verbatim',
      '-F',
      messageFile,
    );
    rmSync(messageFile, { force: true });
    try {
      const raw = logBytes('-1', 'HEAD');
      expect(raw.toString('utf8')).toBe('\ndocs: body content is real\n\0\n');
      expect(parseCommitStream(raw.toString('utf8'))).toEqual(['\ndocs: body content is real\n']);
      const result = runCliRaw(['0.1.7'], raw);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('patch');
    } finally {
      git('reset', '-q', '--soft', 'HEAD~1');
    }
  });

  it('resolves none when every commit in range is docs or chore', () => {
    const raw = logBytes('HEAD~2..HEAD');
    expect(raw.toString('utf8')).toBe(`docs: also\n\0\n${CHORE}\n\0\n`);
    const result = runCliRaw(['0.1.7'], raw);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('none');
  });
});
