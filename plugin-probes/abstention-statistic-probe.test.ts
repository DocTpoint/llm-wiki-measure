// Is the abstention signal there, hidden under a constant?
//
// precision-window-probe measured raw cosine and found no separation: take a
// page out of the vault and the nearest remaining page scores as high as the
// right page did. That was read as "no abstention rule can live in the window".
// But the null model in the same run sat at 0.45, not at 0 - a random item
// paired with a random page already shares nine tenths of what a true pair
// shares. That constant is the shared vocabulary of the corpus: one language,
// one register, one subject area, the same study words on every page. The
// discriminating part of the signal is a thin band riding on top of it, and a
// threshold on the raw number is mostly a threshold on the constant.
//
// So the earlier conclusion may be an artefact of the statistic rather than a
// property of the embedding. This probe re-asks the same question with the
// constant taken out, over the same populations, the same pool and the same
// cached vectors - no new embeddings, no model calls.
//
// Four statistics, all computed per item over the full pool:
//
//   raw       cosine as shipped. The line the earlier probe drew.
//   centred   the pool's mean page vector subtracted from every page and from
//             the item, then renormalised. Removes the one direction every
//             page of this corpus points in.
//   abtt      centred, then the top PCs of the page cloud projected out
//             (all-but-the-top). Removes the few directions that carry
//             register rather than subject.
//   z         how far the best candidate stands out from THIS item's own
//             distribution over the pool, in standard deviations. Needs no
//             vector surgery at all: it asks whether the top hit is special
//             for this item, not whether it clears an absolute bar.
//   margin    top-1 minus top-2. If the page exists, the right one should
//             stand alone; if it does not, the top of the list should be a
//             plateau of equally near neighbours.
//
// The rule shape is the same for all five, so they are comparable: abstain -
// offer no window at all - when the statistic falls below t. On Z+ that is a
// loss whenever the target was in the window; on Z- and F it is correct.
//
// An honest possibility this probe must be able to report: that the constant
// was never the problem, and the distributions stay on top of each other in
// every statistic. That is the outcome the raw arm already suggests, and it
// would say the abstention information is absent rather than hidden.
//
// Read-only, and it never extends the cache: every vector it needs was written
// by precision-window-probe. Copy into <plugin>/src/, run, delete.
//
// | variable                | default                                  |
// |-------------------------|------------------------------------------|
// | LLM_WIKI_VAULT          | required                                 |
// | LLM_WIKI_EMBED_CACHE    | ./embeddings-window.jsonl                |
// | LLM_WIKI_ABTT_K         | 3                                        |
// | LLM_WIKI_ALIAS_LIMIT    | 200                                      |
// | LLM_WIKI_SEED           | 0                                        |

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, appendFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { execSync } from 'child_process';
import { DEFAULT_SETTINGS, type LLMWikiSettings } from './types';
import { slugify } from './core/slug';
import { parseFrontmatter } from './core/frontmatter';
import { ConflictResolver } from './core/conflict-resolver';
import { selectCandidateWindow } from './core/candidate-window';
import { DEDUP_CANDIDATE_TOP_K, CANDIDATE_WINDOW_TEXT_CHARS } from './constants';
import { sourceBaseSlug } from './core/source-slug';

const VAULT = process.env.LLM_WIKI_VAULT!;
const WIKI = process.env.LLM_WIKI_FOLDER ?? 'wiki';
const CASES = process.env.LLM_WIKI_CASES ?? join(VAULT, WIKI, 'schema', 'ambiguity-cases.json');
const NOTE_FOLDERS = (process.env.LLM_WIKI_NOTE_FOLDERS ?? 'Notizen,Frontier-Notizen').split(',').map(s => s.trim()).filter(Boolean);
const EMBED_URL = process.env.LLM_WIKI_EMBED_URL ?? 'http://localhost:1234/v1/embeddings';
const EMBED_MODEL = process.env.LLM_WIKI_EMBED_MODEL ?? 'text-embedding-bge-m3';
const EMBED_BATCH = Number(process.env.LLM_WIKI_EMBED_BATCH ?? 32);
const CACHE = process.env.LLM_WIKI_EMBED_CACHE ?? 'embeddings-window.jsonl';
const ALIAS_LIMIT = Number(process.env.LLM_WIKI_ALIAS_LIMIT ?? 200);
const SEED = Number(process.env.LLM_WIKI_SEED ?? 0);
const K = DEDUP_CANDIDATE_TOP_K;

type PageType = 'entity' | 'concept';
interface Page { path: string; title: string; aliases: string[]; text: string; embedText: string; sourceText: string[]; sources: number }
interface Case {
  id: string; class: string;
  item: { name: string; pageType: PageType; type: string; summary: string; domains: string[] };
  expected: { match: boolean; title?: string };
  expected_note?: string;
  strip_alias?: string;
}
interface Trial { label: string; name: string; summary: string; pool: Page[]; target: string; targetSources: number }

// ---- embeddings (same cache and key as the recall arm) ---------------------

const key = (s: string): string => createHash('sha256').update(EMBED_MODEL + ' ' + s).digest('hex').slice(0, 32);
const vectors = new Map<string, number[]>();

function loadCache(): void {
  if (!existsSync(CACHE)) return;
  for (const line of readFileSync(CACHE, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line) as { k: string; v: number[] }; vectors.set(r.k, r.v); } catch { /* skip */ }
  }
}

function unit(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map(x => x / n);
}

async function embedAll(texts: string[]): Promise<void> {
  const todo = [...new Set(texts)].filter(t => t.trim() && !vectors.has(key(t)));
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    const batch = todo.slice(i, i + EMBED_BATCH);
    const res = await fetch(EMBED_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: batch }),
    });
    if (!res.ok) throw new Error('embeddings ' + res.status + ': ' + (await res.text()));
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    const lines: string[] = [];
    batch.forEach((t, j) => {
      const v = unit(data.data[j].embedding);
      vectors.set(key(t), v);
      lines.push(JSON.stringify({ k: key(t), v }));
    });
    appendFileSync(CACHE, lines.join('\n') + '\n');
    if (i % (EMBED_BATCH * 10) === 0) console.log('  embedded ' + Math.min(i + EMBED_BATCH, todo.length) + '/' + todo.length);
  }
}

function cos(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i];
  return s;
}

// ---- vault (identical loaders to the recall arm, deliberately duplicated) --

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
      noteBySlug.set(sourceBaseSlug(folder + '/' + f, preserve), folder + '/' + f);
    }
  }
  return noteBySlug;
}

const noteCache = new Map<string, string>();
function noteText(sourceSlug: string, preserve: boolean): string {
  if (noteCache.has(sourceSlug)) return noteCache.get(sourceSlug)!;
  let ref = '';
  const sp = join(VAULT, WIKI, 'sources', sourceSlug + '.md');
  if (existsSync(sp)) {
    const sfm = parseFrontmatter(readFileSync(sp, 'utf-8'));
    if (typeof sfm?.source_file === 'string') ref = sfm.source_file.replace(/^\[\[|\]\]$/g, '');
  }
  if (!ref) ref = noteMap(preserve).get(sourceSlug) ?? '';
  const np = ref ? join(VAULT, ref) : '';
  let text = '';
  if (np && existsSync(np)) {
    const body = readFileSync(np, 'utf-8').replace(/^---[\s\S]*?\n---\n?/, '');
    text = (body.split(/\n\s*\n/).find(x => x.trim() && !x.trimStart().startsWith('#')) ?? '').trim().slice(0, 300);
  }
  noteCache.set(sourceSlug, text);
  return text;
}

function loadPages(folder: 'entities' | 'concepts', preserve: boolean): Page[] {
  const dir = join(VAULT, WIKI, folder);
  return readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
    const raw = readFileSync(join(dir, f), 'utf-8');
    const fm = parseFrontmatter(raw) ?? {};
    const sources = Array.isArray(fm.sources) ? fm.sources.map(String) : [];
    const body = raw.replace(/^---[\s\S]*?\n---\n?/, '');
    const title = f.replace(/\.md$/, '');
    return {
      path: WIKI + '/' + folder + '/' + f,
      title,
      aliases: Array.isArray(fm.aliases) ? fm.aliases.map(String) : [],
      text: body.toLowerCase().slice(0, CANDIDATE_WINDOW_TEXT_CHARS),
      embedText: (title + '. ' + body).slice(0, CANDIDATE_WINDOW_TEXT_CHARS),
      sourceText: sources.map(s => {
        const m = /sources\/([^\]|]+)/.exec(s);
        return m ? noteText(m[1].trim(), preserve) : '';
      }),
      sources: sources.length,
    };
  });
}

const sameTypePool = (pages: Page[]): Page[] =>
  pages.filter(p => !/^(entities|concepts|sources)([^\s\-_a-zA-Z0-9])/.test(p.title || ''));

function sample<T>(xs: T[], n: number, seed: number): T[] {
  if (xs.length <= n) return xs;
  let s = seed || 1;
  const rnd = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return out.slice(0, n);
}

/**
 * A fixed reordering, used only to see whether a word ranking is tie-bound.
 * Reversal, not a shuffle: deterministic, and the furthest a pool order can
 * move, so a lead that survives it is held by score and not by position.
 */
const reordered = <T,>(xs: T[]): T[] => [...xs].reverse();

const itemText = (name: string, summary: string): string => (name + '. ' + summary).trim();
const q = (t: Trial | { name: string; summary: string }): number[] => vectors.get(key(itemText(t.name, t.summary)))!;

function quantiles(xs: number[]): { p5: number; p25: number; med: number; p75: number; p95: number } {
  const s = [...xs].sort((a, b) => a - b);
  const at = (f: number): number => s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN;
  return { p5: at(0.05), p25: at(0.25), med: at(0.5), p75: at(0.75), p95: at(0.95) };
}
const f3 = (x: number): string => (Number.isFinite(x) ? x.toFixed(3) : '  -  ').padStart(6);

/** Cosine of every pool page, best first. */
function embedOrder(item: number[], pool: Page[]): Array<{ p: Page; s: number }> {
  return pool
    .map((p, i) => ({ p, s: cos(item, vectors.get(key(p.embedText)) ?? []), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i);
}

/** The shipped word window over the full pool, and whether its lead is tie-bound. */
function wordOrder(name: string, summary: string, pool: Page[]): { order: Page[]; arbitraryLead: boolean } {
  const call = (ps: Page[]): Page[] => selectCandidateWindow(
    { name, context: summary },
    ps.map(p => ({ path: p.path, title: p.title, aliases: p.aliases, text: p.text })),
    ps.length,
    { dfCap: 0.5 },
  ) as unknown as Page[];
  const order = call(pool);
  const alt = call(reordered(pool));
  return { order, arbitraryLead: order[0]?.path !== alt[0]?.path };
}


const ABTT_K = Number(process.env.LLM_WIKI_ABTT_K ?? 3);

// ---- vector surgery --------------------------------------------------------

function meanVector(vs: number[][]): number[] {
  const d = vs[0].length;
  const m = new Array<number>(d).fill(0);
  for (const v of vs) for (let i = 0; i < d; i++) m[i] += v[i];
  for (let i = 0; i < d; i++) m[i] /= vs.length;
  return m;
}

const sub = (v: number[], m: number[]): number[] => v.map((x, i) => x - m[i]);

/** Top-k principal directions of a centred cloud, power iteration with deflation. */
function topComponents(vs: number[][], k: number): number[][] {
  const d = vs[0].length;
  const comps: number[][] = [];
  const work = vs.map(v => [...v]);
  for (let c = 0; c < k; c++) {
    let u = new Array<number>(d).fill(0).map((_, i) => Math.sin(i * (c + 1) + 1));
    u = unit(u);
    for (let it = 0; it < 40; it++) {
      const next = new Array<number>(d).fill(0);
      for (const v of work) {
        let s = 0;
        for (let i = 0; i < d; i++) s += v[i] * u[i];
        for (let i = 0; i < d; i++) next[i] += s * v[i];
      }
      u = unit(next);
    }
    comps.push(u);
    for (const v of work) {
      let s = 0;
      for (let i = 0; i < d; i++) s += v[i] * u[i];
      for (let i = 0; i < d; i++) v[i] -= s * u[i];
    }
  }
  return comps;
}

function project(v: number[], comps: number[][]): number[] {
  const out = [...v];
  for (const u of comps) {
    let s = 0;
    for (let i = 0; i < out.length; i++) s += out[i] * u[i];
    for (let i = 0; i < out.length; i++) out[i] -= s * u[i];
  }
  return out;
}

interface Stats { raw: number; centred: number; abtt: number; z: number; margin: number }

/** Every statistic for one item against one pool, plus the same at the target. */
function statsFor(
  item: { raw: number[]; cen: number[]; ab: number[] },
  pool: Array<{ path: string; raw: number[]; cen: number[]; ab: number[] }>,
  target: string | null,
): { top: Stats; at: Stats | null; targetRank: number } {
  const rawCos = pool.map(p => cos(item.raw, p.raw));
  const cenCos = pool.map(p => cos(item.cen, p.cen));
  const abCos = pool.map(p => cos(item.ab, p.ab));
  const order = rawCos.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s || a.i - b.i);
  const mean = rawCos.reduce((a, b) => a + b, 0) / rawCos.length;
  const sd = Math.sqrt(rawCos.reduce((a, b) => a + (b - mean) * (b - mean), 0) / rawCos.length) || 1e-9;
  const t0 = order[0].i, t1 = order[1]?.i ?? order[0].i;
  const top: Stats = {
    raw: rawCos[t0], centred: cenCos[t0], abtt: abCos[t0],
    z: (rawCos[t0] - mean) / sd, margin: rawCos[t0] - rawCos[t1],
  };
  let at: Stats | null = null;
  let targetRank = -1;
  if (target) {
    const ti = pool.findIndex(p => p.path === target);
    targetRank = order.findIndex(o => o.i === ti) + 1;
    at = { raw: rawCos[ti], centred: cenCos[ti], abtt: abCos[ti], z: (rawCos[ti] - mean) / sd, margin: rawCos[ti] - rawCos[t1] };
  }
  return { top, at, targetRank };
}

const KEYS = ['raw', 'centred', 'abtt', 'z', 'margin'] as const;
function quant(xs: number[], f: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(f * s.length))] : NaN;
}

describe('abstention statistic probe', () => {
  it('does the signal appear once the shared vocabulary is removed', async () => {
    expect(VAULT, 'set LLM_WIKI_VAULT').toBeTruthy();
    const settings = loadSettings();
    const preserve = settings.slugCase === 'preserve';
    const entities = loadPages('entities', preserve);
    const concepts = loadPages('concepts', preserve);
    const all = [...entities, ...concepts];
    let head = 'unknown';
    try {
      head = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim() +
        (execSync('git status --porcelain --untracked-files=no', { encoding: 'utf-8' }).trim() ? '+dirty' : '');
    } catch { /* not a checkout */ }
    console.log(JSON.stringify({
      probe: 'abstention-statistic-probe', at: new Date().toISOString(), plugin: head, vault: VAULT, K,
      embedModel: EMBED_MODEL, abttK: ABTT_K, aliasLimit: ALIAS_LIMIT, seed: SEED,
      pages: { entities: entities.length, concepts: concepts.length },
    }));

    loadCache();
    await embedAll(all.map(p => p.embedText));

    for (const [pages, pageType] of [[entities, 'entity'], [concepts, 'concept']] as const) {
      const pool0 = sameTypePool(pages);
      const raws = pool0.map(p => vectors.get(key(p.embedText))!);

      // How anisotropic is this cloud? The number that says whether the
      // objection has a target: a mean vector of length ~0 means the pages
      // point in all directions and there is no constant to remove.
      const mu = meanVector(raws);
      const muLen = Math.sqrt(mu.reduce((a, b) => a + b * b, 0));
      const centred = raws.map(v => unit(sub(v, mu)));
      const comps = topComponents(centred.map(v => [...v]), ABTT_K);
      const abtt = centred.map(v => unit(project(v, comps)));
      const pool = pool0.map((p, i) => ({ path: p.path, raw: raws[i], cen: centred[i], ab: abtt[i] }));

      let pairMean = 0, n = 0;
      for (let i = 0; i < Math.min(300, raws.length); i++) {
        for (let j = i + 1; j < Math.min(300, raws.length); j++) { pairMean += cos(raws[i], raws[j]); n++; }
      }
      pairMean /= n;

      // The trials, drawn exactly as the precision probe draws them.
      const pairs: Array<{ p: Page; alias: string }> = [];
      for (const p of pool0) for (const alias of p.aliases) if (alias.trim()) pairs.push({ p, alias });
      const trials: Array<{ name: string; summary: string; target: string }> = [];
      for (const pair of sample(pairs, ALIAS_LIMIT, SEED)) {
        const p = pair.p, alias = pair.alias;
        const hide = (x: Page): Page => x.path === p.path ? { ...x, aliases: x.aliases.filter(a => a !== alias) } : x;
        const cr = new ConflictResolver(WIKI, all.map(hide)).resolve({ name: alias, slug: slugify(alias, preserve), pageType, tags: [] });
        if (cr.action === 'merge' && !cr.reason.includes('Cross-type')) continue;
        const summary = p.sourceText[0] ?? '';
        if (!summary) continue;
        trials.push({ name: alias, summary, target: p.path });
      }
      await embedAll(trials.map(t => itemText(t.name, t.summary)));

      console.log('\n=== ' + pageType + 's - ' + trials.length + ' trials, pool ' + pool.length);
      console.log('  anisotropy: |mean page vector| = ' + muLen.toFixed(3) +
        ', mean pairwise cosine = ' + pairMean.toFixed(3) +
        '   <- how much of every score is the corpus, not the pair');

      const zp: Record<string, number[]> = {}, zm: Record<string, number[]> = {};
      for (const k of KEYS) { zp[k] = []; zm[k] = []; }
      const targetInWindow: boolean[] = [];

      for (const t of trials) {
        const iv = vectors.get(key(itemText(t.name, t.summary)))!;
        const icen = unit(sub(iv, mu));
        const iab = unit(project(icen, comps));
        const item = { raw: iv, cen: icen, ab: iab };
        // Z+ : the whole pool. The decision variable is the window's top.
        const plus = statsFor(item, pool, t.target);
        targetInWindow.push(plus.targetRank >= 1 && plus.targetRank <= K);
        for (const k of KEYS) zp[k].push(plus.top[k]);
        // Z- : the target removed. Same variable, no right answer in the pool.
        const minus = statsFor(item, pool.filter(p => p.path !== t.target), null);
        for (const k of KEYS) zm[k].push(minus.top[k]);
      }

      const inWin = targetInWindow.filter(Boolean).length;
      console.log('  target in window (raw ranking): ' + inWin + '/' + trials.length);
      console.log('\n  statistic   Z+ median   Z- median   overlap   |  abstains on Z- at 95 % of targets kept');
      for (const k of KEYS) {
        const P = zp[k], M = zm[k];
        // Overlap: share of Z- values above the 5th percentile of Z+ - the
        // fraction a threshold can never separate.
        const t95 = quant(P, 0.05);
        const stopped = M.filter(x => x < t95).length;
        const overlap = M.filter(x => x >= t95).length / M.length;
        console.log('  ' + k.padEnd(10) + f3(quant(P, 0.5)) + '   ' + f3(quant(M, 0.5)) +
          '   ' + (100 * overlap).toFixed(1).padStart(5) + ' %  |  t = ' + f3(t95) +
          '  ->  ' + (100 * stopped / M.length).toFixed(1).padStart(5) + ' %');
      }
      console.log('\n  the same at 90 % and 80 % of targets kept');
      for (const k of KEYS) {
        const P = zp[k], M = zm[k];
        const row = [0.10, 0.20].map(f => {
          const t = quant(P, f);
          return (100 * M.filter(x => x < t).length / M.length).toFixed(1).padStart(5) + ' %';
        });
        console.log('  ' + k.padEnd(10) + ' 90 %: ' + row[0] + '    80 %: ' + row[1]);
      }
    }
  }, 3_600_000);
});
