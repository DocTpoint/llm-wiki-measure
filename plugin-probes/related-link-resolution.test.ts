// Related-link resolution probe — how many related links in a built vault
// actually point at a page that exists, before and after a change to the
// resolver.
//
// Unlike the Python probes in this repository, this one is NOT standalone: it
// imports the plugin's own functions and runs them over your vault. That is the
// point. A reimplementation of the resolver would measure the reimplementation.
// See plugin-probes/README.md for how to run it.
//
// The method worth reusing: a built vault's related sections are model output
// that already passed through whatever resolver was current when the pages were
// written. So the vault's own state *is* the baseline arm. You do not need to
// deploy the old build, re-run an ingest, or write anything — you read the
// pages, run the new resolver over the same text, and count both.
//
// What it measures: the resolution half. Whether a prompt change alters *which*
// names the model produces is a separate, stochastic question that needs
// repeated draws against a live model. This probe cannot answer it.

import { describe, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { parse as parseYaml } from 'yaml';
import { correctRelatedLinkPrefixes, type ExistingPageRef } from './core/related-link-corrector';
import { buildKnownTargets } from './wiki/lint/scanners';

// Vault path and the two localized section headers your vault actually uses.
// Check the headers against a real page before trusting any number: if they do
// not match, every count silently becomes zero.
const VAULT = process.env.LLM_WIKI_VAULT ?? '';
const WIKI_FOLDER = process.env.LLM_WIKI_FOLDER ?? 'wiki';
const LABEL_ENTITIES = process.env.LLM_WIKI_LABEL_ENTITIES ?? 'Related Entities';
const LABEL_CONCEPTS = process.env.LLM_WIKI_LABEL_CONCEPTS ?? 'Related Concepts';
// Must match the vault's `slugCase` setting (.obsidian/plugins/<id>/data.json).
// Getting this wrong moves the numbers: 'preserve' is the stricter arm.
const PRESERVE_CASE = (process.env.LLM_WIKI_SLUG_CASE ?? 'preserve') === 'preserve';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

function frontmatter(content: string): Record<string, unknown> | null {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return null;
  try {
    return parseYaml(content.slice(4, end)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Mirrors getExistingWikiPages: same filters, title = basename, aliases from frontmatter. */
function loadVault() {
  const pages: ExistingPageRef[] = [];
  const bodies = new Map<string, string>();

  for (const abs of walk(join(VAULT, WIKI_FOLDER))) {
    const path = relative(VAULT, abs);
    if (path.includes('index.md') || path.includes('log.md')) continue;
    if (path.includes('/schema/') || path.includes('/contradictions/')) continue;
    const content = readFileSync(abs, 'utf8');
    const fm = frontmatter(content);
    if (fm && fm.type === 'welcome') continue;
    const title = abs.split('/').pop()!.replace(/\.md$/, '');
    const aliases = Array.isArray(fm?.aliases)
      ? ((fm!.aliases as unknown[]).filter(a => typeof a === 'string') as string[])
      : undefined;
    pages.push({ path, title, aliases });
    bodies.set(path, content);
  }
  return { pages, bodies };
}

/** Link targets inside the two related sections, in document order. */
function relatedTargets(content: string): string[] {
  const out: string[] = [];
  let inSection = false;
  for (const line of content.split('\n')) {
    const h = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (h) {
      const t = h[1].trim();
      inSection = t === LABEL_ENTITIES || t === LABEL_CONCEPTS;
      continue;
    }
    if (!inSection) continue;
    for (const m of line.matchAll(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g)) out.push(m[1]);
  }
  return out;
}

describe('related-link resolution over a built vault', () => {
  it('counts what resolves before and after', { timeout: 120_000 }, () => {
    if (!VAULT) throw new Error('Set LLM_WIKI_VAULT to your vault root.');
    const { pages, bodies } = loadVault();

    // Judge resolution the way the plugin judges it. scanDeadLinks matches over
    // buildKnownTargets, which accepts a basename and every path suffix — so a
    // bare [[Dopamin]] is NOT a dead link. Counting "does this exact path
    // exist" instead inflates the gain and can hide regressions: on the vault
    // this was built for, the narrow check reported zero regressions where the
    // plugin's own semantics found seven.
    const { known, knownLower } = buildKnownTargets(
      pages.map(p => ({ basename: p.title, path: p.path })),
    );
    const resolves = (target: string): boolean => {
      const t = target.trim();
      if (known.has(t) || knownLower.has(t.toLowerCase())) return true;
      const parts = t.split('/');
      const slugged = [...parts.slice(0, -1), parts[parts.length - 1].replace(/\s+/g, '-')].join('/');
      return slugged !== t && (known.has(slugged) || knownLower.has(slugged.toLowerCase()));
    };

    let pagesTouched = 0;
    let linksTotal = 0;
    let resolvedBefore = 0;
    let resolvedAfter = 0;
    const gained: Array<{ page: string; from: string; to: string }> = [];
    const lost: Array<{ page: string; from: string; to: string }> = [];
    const retargeted: Array<{ page: string; from: string; to: string }> = [];

    for (const p of pages) {
      const rel = p.path.slice(WIKI_FOLDER.length + 1).replace(/\.md$/, '');
      if (!rel.startsWith('entities/') && !rel.startsWith('concepts/')) continue;
      const content = bodies.get(p.path)!;
      const before = relatedTargets(content);
      if (before.length === 0) continue;
      pagesTouched++;

      const after = relatedTargets(
        correctRelatedLinkPrefixes(
          content,
          undefined,
          undefined,
          LABEL_ENTITIES,
          LABEL_CONCEPTS,
          PRESERVE_CASE,
          { wikiFolder: WIKI_FOLDER, pages },
        ),
      );

      // Position-faithful: the resolver rewrites links, it never reorders them.
      for (let i = 0; i < before.length; i++) {
        linksTotal++;
        const b = before[i];
        const a = after[i] ?? b;
        const okB = resolves(b);
        const okA = resolves(a);
        if (okB) resolvedBefore++;
        if (okA) resolvedAfter++;
        if (!okB && okA) gained.push({ page: rel, from: b, to: a });
        if (okB && !okA) lost.push({ page: rel, from: b, to: a });
        // Both resolve, but the target changed: no resolution won or lost, and
        // still a different claim about what this page relates to.
        if (okB && okA && a !== b) retargeted.push({ page: rel, from: b, to: a });
      }
    }

    const pct = (n: number) => ((n / linksTotal) * 100).toFixed(2);
    console.log('\n===== related-link resolution =====');
    console.log(`pages with related links : ${pagesTouched}`);
    console.log(`links total              : ${linksTotal}`);
    console.log(`resolving before         : ${resolvedBefore}  (${pct(resolvedBefore)} %)`);
    console.log(`resolving after          : ${resolvedAfter}  (${pct(resolvedAfter)} %)`);
    console.log(`newly resolving          : ${gained.length}`);
    console.log(`no longer resolving      : ${lost.length}`);
    console.log(`retargeted (both resolve): ${retargeted.length}`);
    console.log(`dead after               : ${linksTotal - resolvedAfter}`);

    // A regression is worth reading one by one; there are never many, and they
    // are the only part of the output that can veto a change.
    if (lost.length) {
      console.log('\n--- every regression ---');
      for (const l of lost) console.log(`  ${l.page}: [[${l.from}]] -> [[${l.to}]]`);
    }
    console.log('\n--- sample of gains (20) ---');
    for (const g of gained.slice(0, 20)) console.log(`  ${g.page}: [[${g.from}]] -> [[${g.to}]]`);
    console.log('===================================\n');
  });
});
