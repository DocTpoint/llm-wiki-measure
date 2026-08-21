// Does the true page land in the dedup window? — the probe after the
// ambiguity probe's finding that the LEVER IS THE WINDOW.
//
// Semantic dedup shows the model a list of same-type pages. S108 measured what
// the lexical top-K costs (drops the true page in 13.6% / 9.8% of alias trials)
// and how often the name-gate falls back to the FULL list (61% / 41%). S115
// then measured what the full list buys at a local 26B: nothing — 0 of 18
// calls found a synonym's target in ~1,200 entries, while the same model found
// the same targets 9 of 9 times in a 30-entry window that contained them.
// So the question is no longer "cap or not", it is: WHICH RANKING puts the
// target into 30 slots, using only what the caller has without a model call.
//
// Five window arms, all top-K (DEDUP_CANDIDATE_TOP_K = 30):
//
//   0  status quo      selectDedupCandidates as shipped — name-gate, then
//                      lexical rank on name + summary, else the full list
//   1  lexical         the same lexical score, but ALWAYS ranked, no full list
//   2  + domains       1 + W per domain the item shares with the page
//   3  + text          1 + T per item-summary keyword (>= 5 chars, stop-listed)
//                      found in the page's own prose (first paragraph excluded)
//   4  + both          2 + 3
//   P  shipped window  the production `selectCandidateWindow` (PR for the
//                      window): lexical + prose with a document-frequency cap
//                      instead of a stop list; reported at caps 0.5 / 0.25 /
//                      1.0 (no cap). Meaningful in ITEM_SUMMARY=note mode
//                      only — in page mode the item summary IS the page's
//                      first paragraph and the arm would match itself.
//
// Two case sets, reported apart and never pooled:
//
//   S  the synonym cases of ambiguity-cases.json that have a target (the hard,
//      hand-picked ones; a curated alias is stripped where the file says so,
//      else the resolver would answer without a call). Page domains are the
//      union of the tags of the notes behind `sources:` (as in S115, an upper
//      bound of what the stage-3 writer delivers); item domains from the file.
//   A  every curated alias of every page, hidden from the index (the S108
//      recall arm). The item is the alias; its summary is the page's first
//      paragraph (the S108 arm) — or, with LLM_WIKI_ITEM_SUMMARY=note, the
//      first 300 chars of the left-out source note: text the page did not
//      write itself, which is the objection to arm 3 on this set. Domains are
//      LEAVE-ONE-OUT: the item carries the tags of the page's FIRST source
//      note, the page the union over its OTHER sources — a new mention comes
//      from a note that is not yet among the page's sources, and a page with a
//      single source is domain-blind on its first re-mention, which is the
//      real structure of this vault (two thirds of its pages have one source).
//      LLM_WIKI_DOMAIN_MODE=all gives the upper bound (union on both sides).
//      A trial the ConflictResolver decides (slug/alias key match) never
//      reaches dedup and is counted out, not in.
//
// Read the rank columns, not only the hit rate: an arm that moves the target
// from rank 400 to rank 45 has found the signal even if 30 is still missed.
//
// Read-only, no model call. Copy into <plugin>/src/, run, delete.
//
// | variable               | default                                   |
// |------------------------|-------------------------------------------|
// | LLM_WIKI_VAULT         | required                                  |
// | LLM_WIKI_FOLDER        | wiki                                      |
// | LLM_WIKI_CASES         | <vault>/wiki/schema/ambiguity-cases.json  |
// | LLM_WIKI_NOTE_FOLDERS  | Notizen,Frontier-Notizen                  |
// | LLM_WIKI_DOMAIN_MODE   | loo (leave-one-out) | all                  |
// | LLM_WIKI_DOMAIN_W      | 3  (one title hit)                        |
// | LLM_WIKI_TEXT_W        | 1                                         |
// | LLM_WIKI_TEXT_CHARS    | 2000 (page prose scanned per trial)       |
// | LLM_WIKI_LIST_ELSEWHERE| unset; 1 = list every alias the resolver sends to another page |
// | LLM_WIKI_ITEM_SUMMARY  | page | note — set A's item summary: the page's
// |                        | first paragraph (S108 arm) or the first 300 chars
// |                        | of the left-out source NOTE (independent text)  |

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { DEFAULT_SETTINGS, type LLMWikiSettings } from './types';
import { slugify } from './core/slug';
import { parseFrontmatter } from './core/frontmatter';
import { ConflictResolver } from './core/conflict-resolver';
import { localKeywordMatch } from './core/index-search';
import { selectDedupCandidates } from './wiki/page-factory/path-resolution';
import { DEDUP_CANDIDATE_TOP_K, CANDIDATE_WINDOW_TEXT_CHARS } from './constants';
import { selectCandidateWindow } from './core/candidate-window';
import { sourceBaseSlug } from './core/source-slug';

const VAULT = process.env.LLM_WIKI_VAULT!;
const WIKI = process.env.LLM_WIKI_FOLDER ?? 'wiki';
const CASES = process.env.LLM_WIKI_CASES ?? join(VAULT, WIKI, 'schema', 'ambiguity-cases.json');
const NOTE_FOLDERS = (process.env.LLM_WIKI_NOTE_FOLDERS ?? 'Notizen,Frontier-Notizen').split(',').map(s => s.trim()).filter(Boolean);
const DOMAIN_MODE = (process.env.LLM_WIKI_DOMAIN_MODE ?? 'loo') as 'loo' | 'all';
const W_DOMAIN = Number(process.env.LLM_WIKI_DOMAIN_W ?? 3);
const W_TEXT = Number(process.env.LLM_WIKI_TEXT_W ?? 1);
const TEXT_CHARS = Number(process.env.LLM_WIKI_TEXT_CHARS ?? 2000);
const ITEM_SUMMARY = (process.env.LLM_WIKI_ITEM_SUMMARY ?? 'page') as 'page' | 'note';
const LIST_ELSEWHERE = process.env.LLM_WIKI_LIST_ELSEWHERE === '1';
const K = DEDUP_CANDIDATE_TOP_K;

type PageType = 'entity' | 'concept';
interface Page {
  path: string; title: string; aliases: string[]; ctime: number;
  summary: string;        // first paragraph, 300 chars — the item-summary proxy of the S108 arm
  text: string;           // the rest of the prose, lower-cased, capped — arm 3's matching surface
  prodText: string;       // the body as getExistingWikiPages ships it: lower-cased, first CANDIDATE_WINDOW_TEXT_CHARS — arm P's surface
  sourceTags: string[][]; // tags of the note behind each `sources:` entry, aligned
  sourceText: string[];   // first 300 chars of that note's body, aligned ('' when unresolved)
  domains: string[];      // union of sourceTags
}
interface Item { name: string; summary: string; domains: string[] }
interface Case {
  id: string; class: string;
  item: { name: string; pageType: PageType; type: string; summary: string; domains: string[] };
  expected: { match: boolean; title?: string };
  strip_alias?: string;
}

const STOP = new Set(['eine', 'einer', 'eines', 'einem', 'einen', 'nicht', 'auch', 'oder', 'werden', 'wurde', 'wurden', 'durch',
  'sowie', 'dieser', 'diese', 'dieses', 'unter', 'über', 'kann', 'können', 'sind', 'wird', 'haben', 'sollte', 'sollten', 'zwischen',
  'welche', 'welcher', 'ihre', 'ihrer', 'seine', 'seiner', 'dabei', 'damit', 'dann', 'wenn', 'aber', 'noch', 'nach', 'beim', 'gegen',
  'etwa', 'sehr', 'mehr', 'viele', 'vielen', 'allem', 'allen', 'andere', 'anderen', 'einige', 'einigen', 'sowohl', 'weniger', 'deren']);

function loadSettings(): LLMWikiSettings {
  const p = join(VAULT, '.obsidian', 'plugins', 'karpathywiki', 'data.json');
  const data = existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) as Partial<LLMWikiSettings> : {};
  return { ...DEFAULT_SETTINGS, ...data };
}

let noteBySlug: Map<string, string> | null = null;
function noteMap(preserve: boolean): Map<string, string> {
  if (noteBySlug) return noteBySlug;
  noteBySlug = new Map();
  for (const folder of NOTE_FOLDERS) {
    const dir = join(VAULT, folder);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      noteBySlug.set(sourceBaseSlug(`${folder}/${f}`, preserve), `${folder}/${f}`);
    }
  }
  return noteBySlug;
}

const noteCache = new Map<string, { tags: string[]; text: string }>();
function noteForSource(sourceSlug: string, preserve: boolean): { tags: string[]; text: string } {
  if (noteCache.has(sourceSlug)) return noteCache.get(sourceSlug)!;
  let tags: string[] = [];
  let text = '';
  let ref = '';
  const sp = join(VAULT, WIKI, 'sources', `${sourceSlug}.md`);
  if (existsSync(sp)) {
    const sfm = parseFrontmatter(readFileSync(sp, 'utf-8'));
    if (typeof sfm?.source_file === 'string') ref = sfm.source_file.replace(/^\[\[|\]\]$/g, '');
  }
  if (!ref) ref = noteMap(preserve).get(sourceSlug) ?? '';
  const np = ref ? join(VAULT, ref) : '';
  if (np && existsSync(np)) {
    const raw = readFileSync(np, 'utf-8');
    const nfm = parseFrontmatter(raw);
    if (Array.isArray(nfm?.tags)) tags = nfm.tags.map(String).map(t => t.trim()).filter(Boolean);
    const body = raw.replace(/^---[\s\S]*?\n---\n?/, '');
    text = (body.split(/\n\s*\n/).find(x => x.trim() && !x.trimStart().startsWith('#')) ?? '').trim().slice(0, 300);
  }
  const v = { tags, text };
  noteCache.set(sourceSlug, v);
  return v;
}

function loadPages(folder: 'entities' | 'concepts', preserve: boolean): Page[] {
  const dir = join(VAULT, WIKI, folder);
  return readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
    const full = join(dir, f);
    const raw = readFileSync(full, 'utf-8');
    const fm = parseFrontmatter(raw) ?? {};
    const sources = Array.isArray(fm.sources) ? fm.sources.map(String) : [];
    const notes = sources.map(s => {
      const m = /sources\/([^\]|]+)/.exec(s);
      return m ? noteForSource(m[1].trim(), preserve) : { tags: [], text: '' };
    });
    const sourceTags = notes.map(n => n.tags);
    const sourceText = notes.map(n => n.text);
    const domains: string[] = [];
    for (const ts of sourceTags) for (const t of ts) if (!domains.includes(t)) domains.push(t);
    const body = raw.replace(/^---[\s\S]*?\n---\n?/, '');
    const paras = body.split(/\n\s*\n/).filter(x => x.trim());
    const firstIdx = paras.findIndex(x => !x.trimStart().startsWith('#'));
    const first = firstIdx >= 0 ? paras[firstIdx] : '';
    const rest = paras.filter((_, i) => i !== firstIdx).join('\n');
    return {
      path: `${WIKI}/${folder}/${f}`, title: f.replace(/\.md$/, ''),
      aliases: Array.isArray(fm.aliases) ? fm.aliases.map(String) : [],
      ctime: statSync(full).birthtimeMs,
      summary: first.trim().slice(0, 300),
      text: rest.toLowerCase().slice(0, TEXT_CHARS),
      prodText: body.toLowerCase().slice(0, CANDIDATE_WINDOW_TEXT_CHARS),
      sourceTags, sourceText, domains,
    };
  }).sort((a, b) => a.ctime - b.ctime);
}

/** Same-type pool exactly as resolvePagePath builds it (L2 purge, ctime order). */
function sameTypePool(pages: Page[]): Page[] {
  return pages.filter(p => !/^(entities|concepts|sources)([^\s\-_a-zA-Z0-9])/.test(p.title || ''));
}

function textKeywords(summary: string): string[] {
  return [...new Set(summary.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter(k => k.length >= 5 && !STOP.has(k)))];
}

/** Ranks for all five arms: 1-based position of `target` in each arm's ordering; arm 0 may be 'full'. */
function ranks(item: Item, pool: Page[], target: string): { r0: number | 'full'; r1: number; r2: number; r3: number; r4: number; p50: number; p25: number; p100: number } {
  // Arm 0: the shipped function.
  const selected = selectDedupCandidates(item.name, item.summary, pool);
  const r0: number | 'full' = selected.length === pool.length
    ? 'full'
    : (selected.findIndex(p => p.path === target) + 1) || (K + 1); // 0 → not in window; K+1 stands for "dropped"
  // Lexical score exactly as production composes the query.
  const nameQuery = `${item.name} ${item.name.split(/[-_]+/).join(' ')}`;
  const lex = new Map(localKeywordMatch(`${nameQuery} ${item.summary.substring(0, 300)}`, pool).map(r => [r.path, r.score]));
  const itemDomains = new Set(item.domains);
  const kws = textKeywords(item.summary);
  const dom = (p: Page) => { let n = 0; for (const d of p.domains) if (itemDomains.has(d)) n++; return n; };
  const txt = (p: Page) => { let n = 0; for (const k of kws) if (p.text.includes(k)) n++; return n; };
  const rankBy = (score: (p: Page) => number) => {
    const order = pool.map((p, i) => ({ p, s: score(p), i })).sort((a, b) => b.s - a.s || a.i - b.i);
    return order.findIndex(x => x.p.path === target) + 1;
  };
  const l = (p: Page) => lex.get(p.path) ?? 0;
  // Arm P: the shipped function over the shipped page shape, asked for the
  // whole ordering (topK = pool size) so the target's rank is readable.
  const prodPool = pool.map(p => ({ path: p.path, title: p.title, aliases: p.aliases, text: p.prodText }));
  const prodRank = (dfCap: number) =>
    selectCandidateWindow({ name: item.name, context: item.summary }, prodPool, prodPool.length, { dfCap })
      .findIndex(p => p.path === target) + 1;
  return {
    r0,
    r1: rankBy(l),
    r2: rankBy(p => l(p) + W_DOMAIN * dom(p)),
    r3: rankBy(p => l(p) + W_TEXT * txt(p)),
    r4: rankBy(p => l(p) + W_DOMAIN * dom(p) + W_TEXT * txt(p)),
    p50: prodRank(0.5),
    p25: prodRank(0.25),
    p100: prodRank(1.0),
  };
}

type R = ReturnType<typeof ranks>;
const ARMS: Array<{ key: keyof R; label: string }> = [
  { key: 'r0', label: '0 status quo' }, { key: 'r1', label: '1 lexical' }, { key: 'r2', label: '2 +domains' },
  { key: 'r3', label: '3 +text' }, { key: 'r4', label: '4 +both' },
  { key: 'p50', label: 'P df≤0.5' }, { key: 'p25', label: 'P df≤0.25' }, { key: 'p100', label: 'P no cap' },
];

function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; }
function summarize(label: string, rs: R[]) {
  const n = rs.length;
  console.log(`\n${label} — ${n} trials, window ${K}`);
  console.log(`  arm            in-window   median rank   rank≤100   (arm 0: full list)`);
  for (const a of ARMS) {
    const vals = rs.map(r => r[a.key]);
    const full = vals.filter(v => v === 'full').length;
    const nums = vals.filter((v): v is number => typeof v === 'number');
    const hit = nums.filter(v => v <= K).length;
    const le100 = nums.filter(v => v <= 100).length;
    const pct = (x: number) => `${(100 * x / n).toFixed(1).padStart(5)}%`;
    // Arm 0 has no ranks beyond the window (in, dropped, or full list) — its median and ≤100 columns would be artifacts.
    const med = a.key === 'r0' ? '—' : String(median(nums));
    const tail = a.key === 'r0' ? '     —' : pct(le100);
    console.log(`  ${a.label.padEnd(14)} ${pct(hit)} (${String(hit).padStart(4)})   ${med.padStart(6)}        ${tail}   ${a.key === 'r0' ? `${full} (${pct(full)}) — S115: model finds 0/18 there` : ''}`);
  }
}

describe('dedup window probe', () => {
  it('which ranking puts the target into the window', () => {
    expect(VAULT, 'set LLM_WIKI_VAULT').toBeTruthy();
    const settings = loadSettings();
    const preserve = settings.slugCase === 'preserve';
    const entities = loadPages('entities', preserve);
    const concepts = loadPages('concepts', preserve);
    const all = [...entities, ...concepts];
    let head = 'unknown';
    try { head = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim() + (execSync('git status --porcelain --untracked-files=no', { encoding: 'utf-8' }).trim() ? '+dirty' : ''); } catch { /* not a checkout */ }
    console.log(JSON.stringify({
      probe: 'dedup-window-probe', at: new Date().toISOString(), plugin: head, vault: VAULT, K,
      domainMode: DOMAIN_MODE, itemSummary: ITEM_SUMMARY, wDomain: W_DOMAIN, wText: W_TEXT, textChars: TEXT_CHARS,
      pages: { entities: entities.length, concepts: concepts.length },
      pagesWithDomains: all.filter(p => p.domains.length > 0).length,
      pagesWithOneSource: all.filter(p => p.sourceTags.length === 1).length,
    }));

    // ---- Set S: the synonym cases with a target -------------------------------
    const cases = (JSON.parse(readFileSync(CASES, 'utf-8')) as { cases: Case[] }).cases.filter(c => c.expected.match && c.expected.title);
    const setS: R[] = [];
    console.log(`\nSet S — synonym cases (page domains = union over all sources, item domains from the case file)`);
    console.log(`  id   name → target                                        ${ARMS.map(a => a.label.split(' ')[0].padStart(6)).join('')}`);
    for (const c of cases) {
      const folder = c.item.pageType === 'entity' ? 'entities' : 'concepts';
      const pages = (c.item.pageType === 'entity' ? entities : concepts);
      const target = pages.find(p => p.title === c.expected.title)?.path;
      if (!target) { console.log(`  ${c.id}  CASE ERROR: "${c.expected.title}" not in ${folder}/`); continue; }
      const strip = c.strip_alias?.toLowerCase();
      const pool = sameTypePool(strip ? pages.map(p => ({ ...p, aliases: p.aliases.filter(a => a.toLowerCase() !== strip) })) : pages);
      const r = ranks({ name: c.item.name, summary: c.item.summary, domains: c.item.domains }, pool, target);
      setS.push(r);
      const cell = (v: number | 'full') => String(v === 'full' ? 'full' : v === K + 1 ? `>${K}` : v).padStart(6);
      console.log(`  ${c.id.padEnd(4)} ${`${c.item.name} → ${c.expected.title}`.padEnd(52)}${ARMS.map(a => cell(r[a.key])).join('')}`);
    }
    summarize('Set S — synonym cases', setS);

    // ---- Set A: alias trials, leave-one-out domains ---------------------------
    for (const [folder, pages, pageType] of [['entities', entities, 'entity'], ['concepts', concepts, 'concept']] as const) {
      const pool0 = sameTypePool(pages);
      const rs: R[] = [];
      let resolved = 0, resolvedElsewhere = 0, domainBlind = 0, itemNoDomains = 0, noNoteText = 0;
      for (const p of pool0) {
        for (const alias of p.aliases) {
          if (!alias.trim()) continue;
          const hide = (q: Page) => q.path === p.path ? { ...q, aliases: q.aliases.filter(a => a !== alias) } : q;
          const pool = pool0.map(hide);
          // The real gate: a name the index still resolves never reaches dedup.
          const cr = new ConflictResolver(WIKI, all.map(hide)).resolve({ name: alias, slug: slugify(alias, preserve), pageType, tags: [] });
          if (cr.action === 'merge' && !cr.reason.includes('Cross-type')) {
            resolved++;
            if (cr.targetPath !== p.path) { resolvedElsewhere++; if (LIST_ELSEWHERE) console.log(`  ELSEWHERE ${JSON.stringify(alias)} carried by ${p.path} → resolver: ${cr.targetPath} (${cr.reason})`); }
            continue;
          }
          const itemDomains = DOMAIN_MODE === 'all' ? p.domains : (p.sourceTags[0] ?? []);
          if (itemDomains.length === 0) itemNoDomains++;
          const withDomains = DOMAIN_MODE === 'all' ? pool : pool.map(q => {
            if (q.path !== p.path) return q;
            const rest: string[] = [];
            for (const ts of q.sourceTags.slice(1)) for (const t of ts) if (!rest.includes(t)) rest.push(t);
            return { ...q, domains: rest };
          });
          if (withDomains.find(q => q.path === p.path)!.domains.length === 0) domainBlind++;
          const summary = ITEM_SUMMARY === 'note' ? (p.sourceText[0] ?? '') : p.summary;
          if (ITEM_SUMMARY === 'note' && !summary) { noNoteText++; continue; }
          rs.push(ranks({ name: alias, summary, domains: itemDomains }, withDomains, p.path));
        }
      }
      summarize(`Set A — ${folder} alias trials (domains: ${DOMAIN_MODE}, item summary: ${ITEM_SUMMARY})`, rs);
      if (ITEM_SUMMARY === 'note') console.log(`  counted out: ${noNoteText} trials whose first source note could not be read`);
      console.log(`  counted out: ${resolved} trials the ConflictResolver decides without a call (${resolvedElsewhere} of them to ANOTHER page)`);
      console.log(`  domain arms blind: target page has no other-source domains in ${domainBlind} trials, item has none in ${itemNoDomains}`);
    }
  }, 600_000); // ~65 s on 2,400 pages: the resolver runs once per trial
});
