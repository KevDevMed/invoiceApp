/**
 * The marketing landing page is a hand-written static file with no build step,
 * so nothing else would catch a broken download URL, a missing hero image or an
 * accidental CDN reference. These read the file off disk and assert the
 * properties that make it correct: the exact release asset names, the two
 * in-app routes, one document outline, the metadata, and the promise that the
 * page loads nothing from the network.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const landingDir = path.resolve(here, '..', 'landing');
const assetsDir = path.resolve(landingDir, 'assets');
const html = fs.readFileSync(path.join(landingDir, 'index.html'), 'utf8');

const ARM_DMG =
  'https://github.com/KevDevMed/invoiceApp/releases/latest/download/InvoiceApp-mac-arm64.dmg';
const INTEL_DMG =
  'https://github.com/KevDevMed/invoiceApp/releases/latest/download/InvoiceApp-mac-x64.dmg';

/** `<img ...>` tags, whole tag captured so attributes can be inspected. */
function imgTags(): string[] {
  return html.match(/<img\b[^>]*>/gis) ?? [];
}

describe('download links', () => {
  it('links the Apple Silicon dmg by its exact stable asset name', () => {
    expect(html).toContain(`href="${ARM_DMG}"`);
  });

  it('links the Intel dmg by its exact stable asset name', () => {
    expect(html).toContain(`href="${INTEL_DMG}"`);
  });

  it('links the browser preview and the install instructions', () => {
    expect(html).toContain('href="/app"');
    expect(html).toContain('href="/download"');
  });

  it('links the source repository', () => {
    expect(html).toContain('href="https://github.com/KevDevMed/invoiceApp"');
  });
});

describe('document outline and metadata', () => {
  it('has exactly one h1', () => {
    expect(html.match(/<h1[\s>]/gi) ?? []).toHaveLength(1);
  });

  it('skips no heading level', () => {
    const levels = [...html.matchAll(/<h([1-6])[\s>]/gi)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      const previous = levels[i - 1] ?? 0;
      const current = levels[i] ?? 0;
      expect(current, `h${previous} is followed by h${current}`).toBeLessThanOrEqual(previous + 1);
    }
  });

  it('has a non-empty title', () => {
    const title = html.match(/<title>([\s\S]*?)<\/title>/i);
    expect(title).not.toBeNull();
    expect(title?.[1]?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it('has a non-empty meta description', () => {
    const meta = html.match(/<meta\s+[^>]*name="description"[^>]*>/i)?.[0];
    expect(meta).toBeDefined();
    const content = meta?.match(/content="([\s\S]*?)"/i)?.[1] ?? '';
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it('has the Open Graph tags', () => {
    for (const property of ['og:title', 'og:description', 'og:type']) {
      expect(html).toContain(`property="${property}"`);
    }
  });
});

describe('claims about the build', () => {
  it('states the Electron 38 minimum of macOS 12 and never the dropped macOS 11', () => {
    expect(html).toContain('macOS 12 Monterey or later');
    expect(html).not.toMatch(/macOS 11/i);
    expect(html).not.toMatch(/Big Sur/i);
  });

  it('does not tell the reader to back up the SQLite file on its own', () => {
    // The database runs in WAL mode (src/db/client.ts), so committed rows can
    // live only in the -wal sidecar until a checkpoint.
    expect(html).not.toMatch(/Back it up by copying it/i);
    expect(html).toContain('-wal');
    expect(html).toContain('-shm');
    expect(html).toMatch(/quit the app first/i);
  });
});

describe('no network dependencies', () => {
  it('loads no external script', () => {
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/i);
  });

  it('loads no external stylesheet', () => {
    expect(html).not.toMatch(/<link\b[^>]*rel="stylesheet"/i);
  });

  it('loads no remote resource via src= or url()', () => {
    expect(html).not.toMatch(/src="https?:/i);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/i);
  });

  it('still allows github.com anchor hrefs', () => {
    expect(html).toMatch(/href="https:\/\/github\.com\//i);
  });
});

describe('images', () => {
  it('references at least one image', () => {
    expect(imgTags().length).toBeGreaterThan(0);
  });

  it('resolves every /landing/assets/ image to a file inside the assets directory', () => {
    const referenced = [...html.matchAll(/src="\/landing\/assets\/([^"]+)"/g)].map((m) => m[1]);
    expect(referenced.length).toBeGreaterThan(0);

    for (const name of referenced) {
      expect(name, 'the file name capture group should have matched').toBeDefined();
      // `<unmatched>` can never exist on disk, so a missing capture still fails below.
      const onDisk = path.resolve(assetsDir, name ?? '<unmatched>');
      // Existence alone would pass for `../../../package.json`, which the browser
      // would refuse to serve, so the path has to stay inside the assets folder.
      expect(
        onDisk === assetsDir || onDisk.startsWith(assetsDir + path.sep),
        `${name} should resolve inside preview/landing/assets/, got ${onDisk}`,
      ).toBe(true);
      expect(fs.existsSync(onDisk), `${name} should exist under preview/landing/assets/`).toBe(
        true,
      );
    }
  });

  it('gives every image a non-empty alt', () => {
    for (const tag of imgTags()) {
      const alt = tag.match(/\balt="([\s\S]*?)"/i)?.[1];
      expect(alt, `missing alt on ${tag.slice(0, 60)}`).toBeDefined();
      expect((alt ?? '').trim().length, `empty alt on ${tag.slice(0, 60)}`).toBeGreaterThan(0);
    }
  });
});
