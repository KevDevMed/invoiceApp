import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCommitStream, resolveReleaseBump } from '../resolve-release-bump';

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

    it('does not fire on a marker inside a fence or a blockquote', () => {
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
      // ...but a segment with content IS a commit and survives the parse. Its
      // leading newline is git's entry separator, not part of the message.
      expect(parseCommitStream('\nbody describes shipped fix\0')).toEqual([
        'body describes shipped fix',
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
});
