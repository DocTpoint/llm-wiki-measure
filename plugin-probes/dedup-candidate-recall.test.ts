// The recall arm to the fallback-rate probe.
//
// The full-list fallback exists to protect the case the code comment names:
// "MIT" vs "Massachusetts Institute of Technology" share no token, so a
// lexical top-K would drop the true duplicate. The cost of that protection is
// now measured (61% of entity dedups ship the whole list). This asks the other
// half: how large is the case being protected?
//
// The arm: a curated alias IS an alternative name for its own page — and it
// is a name a model demonstrably produces, since curation took it from real
// output. To make it the case dedup actually sees, the alias is REMOVED from
// the index first: a name the vault already lists is resolved by the
// ConflictResolver and never reaches the LLM at all. What remains is exactly
// the hard case — a known-correct answer whose surface form the index does
// not carry.
//
// Read-only, no model call. Set LLM_WIKI_VAULT.

import { describe, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { selectDedupCandidates } from './wiki/page-factory/path-resolution';

const VAULT = process.env.LLM_WIKI_VAULT!;
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
          if (Array.isArray(fm?.aliases)) aliases = (fm.aliases as unknown[]).map(String);
        } catch { /* ignore */ }
      }
    }
    const body = raw.replace(/^---[\s\S]*?\n---\n?/, '');
    const firstPara = body.split(/\n\s*\n/).find(x => x.trim() && !x.startsWith('#')) ?? '';
    return { path: `${WIKI}/${folder}/${f}`, title: f.replace(/\.md$/, ''), aliases,
             summary: firstPara.trim().slice(0, 300) };
  });
}

describe('dedup recall arm', () => {
  it('how often is the full-list fallback the only thing that finds the page', () => {
    for (const folder of ['entities', 'concepts']) {
      const pages = load(folder);
      const withAlias = pages.filter(p => p.aliases.length > 0);
      let trials = 0, fellBack = 0, foundInTopK = 0, lostInTopK = 0;

      for (const p of withAlias) {
        for (const alias of p.aliases) {
          if (!alias.trim()) continue;
          trials++;
          // Hide this alias: the vault must not already know the surface form.
          const pool = pages.map(q => q.path === p.path
            ? { ...q, aliases: q.aliases.filter(a => a !== alias) }
            : q);
          const picked = selectDedupCandidates(alias, p.summary, pool);
          if (picked.length === pages.length) { fellBack++; continue; }  // full list — page is in it
          if (picked.some(c => c.path === p.path)) foundInTopK++;
          else lostInTopK++;   // filtered, and the true page was dropped
        }
      }

      const pct = (n: number) => `${(100 * n / trials).toFixed(1)}%`;
      console.log(
        `\n${folder}: ${trials} alias trials on ${withAlias.length} pages with aliases\n` +
        `  fell back to full list : ${fellBack} (${pct(fellBack)})  — no lexical hit at all\n` +
        `  top-K kept its own page: ${foundInTopK} (${pct(foundInTopK)})\n` +
        `  top-K DROPPED it       : ${lostInTopK} (${pct(lostInTopK)})  ← what a cap would cost`
      );
    }
  });
});
