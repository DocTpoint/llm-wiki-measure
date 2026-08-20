// How often does the dedup pre-filter fall back to the FULL page list?
//
// `selectDedupCandidates` keeps the top 30 lexical candidates, but returns
// every same-type page when the *name* produces no keyword hit at all. The
// comment calls that "rare" and pays the full-list prompt for it. Rare was
// never measured. On this vault the full list is 1296 entities / 1120
// concepts, and in July such calls cost ~53s each for an 18-token answer.
//
// The vault is the arm: its page names are real extraction output. For each
// page we ask what would happen if that name arrived again without an exact
// slug/alias match — which is exactly when the LLM dedup runs.
//
// Read-only. No model call. Set LLM_WIKI_VAULT.

import { describe, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { selectDedupCandidates } from './wiki/page-factory/path-resolution';

const VAULT = process.env.LLM_WIKI_VAULT ?? '';
const WIKI = process.env.LLM_WIKI_FOLDER ?? 'wiki';

type Page = { path: string; title: string; aliases: string[]; summary: string };

function load(folder: string): Page[] {
  const dir = join(VAULT, WIKI, folder);
  return readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
    const raw = readFileSync(join(dir, f), 'utf-8');
    let aliases: string[] = [];
    if (raw.startsWith('---')) {
      const end = raw.indexOf('\n---', 3);
      if (end > 0) {
        try {
          const fm = parseYaml(raw.slice(3, end)) as Record<string, unknown>;
          const a = fm?.aliases;
          if (Array.isArray(a)) aliases = a.map(String);
        } catch { /* unparsable frontmatter — treat as no aliases */ }
      }
    }
    const body = raw.replace(/^---[\s\S]*?\n---\n?/, '');
    const firstPara = body.split(/\n\s*\n/).find(p => p.trim() && !p.startsWith('#')) ?? '';
    return {
      path: `${WIKI}/${folder}/${f}`,
      title: f.replace(/\.md$/, ''),
      aliases,
      summary: firstPara.trim().slice(0, 300),
    };
  });
}

describe('dedup pre-filter fallback rate', () => {
  it('measures how often the full same-type list reaches the prompt', () => {
    if (!VAULT) throw new Error('set LLM_WIKI_VAULT');

    for (const folder of ['entities', 'concepts']) {
      const pages = load(folder);
      let fallback = 0;
      let sumFull = 0, sumFiltered = 0;

      for (const p of pages) {
        // The candidate arrives without an exact match, so it is not itself
        // in the pool it is compared against.
        const others = pages.filter(o => o.path !== p.path);
        const picked = selectDedupCandidates(p.title.replace(/-/g, ' '), p.summary, others);
        if (picked.length === others.length) { fallback++; sumFull += others.length; }
        else sumFiltered += picked.length;
      }

      const hits = pages.length - fallback;
      const pct = (100 * fallback / pages.length).toFixed(1);
      console.log(
        `\n${folder}: ${pages.length} pages\n` +
        `  full-list fallback : ${fallback} (${pct}%)  → avg ${fallback ? Math.round(sumFull / fallback) : 0} pages into the prompt\n` +
        `  filtered to top-K  : ${hits} (${(100 - +pct).toFixed(1)}%)  → avg ${hits ? Math.round(sumFiltered / hits) : 0} pages`
      );
    }
  });
});
