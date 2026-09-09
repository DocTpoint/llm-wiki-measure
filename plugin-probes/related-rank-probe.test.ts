// Does a meaning ranking pick a different Related list than the shipped one?
//
// The dedup window had an oracle: hide a curated alias and you know which page
// the item belongs to. A Related list has none. Nobody has written down the
// right five neighbours for a page, and a model asked to judge them is the
// same family of model that wrote them.
//
// So this probe does NOT ask which ranking is better. It asks the question
// that comes first and is answerable without an oracle: CAN the two rankings
// differ, and by how much. If shared-source rank and cosine rank keep the same
// five entries, the whole question is moot and no oracle needs inventing. If
// they diverge, the size and shape of the divergence says how sharp an oracle
// would have to be to separate them.
//
// Three arms over one candidate set, one run:
//
//   S  shipped    `rankAndCap` from core/related-sections.ts, the real
//                 function: shared sources descending, rarer page first, then
//                 the title, cut at RELATED_CAP.
//   E  meaning    cosine between the page's vector and each candidate's, same
//                 text form as the window probes, cut at the same K.
//   N  null       the same cosine ranking asked with ANOTHER page's vector.
//                 An arm that agrees with S as often as N does has agreed by
//                 arithmetic, not by meaning.
//
// Plus a shuffled arm for the chance level, because the overlap of two top-5
// lists drawn from eight candidates is high before anything is measured.
//
// The candidate set is each page's CURRENT Related entries in the vault under
// test. On the 413-note archive those lists are uncapped (up to 73 entries),
// which is exactly the set patch 23's rank was built to cut down to five, so
// the comparison is the real decision on real input rather than a
// reconstruction of the ingest.
//
// Reported apart and never pooled: pages whose candidates all share a source
// with them (the siblings, ~97 % of the vault) and pages that carry at least
// one non-sibling. The sibling block is where the arms actually compete — S is
// ordering within a relation E cannot see, E is ordering within a relation S
// has already spent.
//
// Also reported: the two-hop pair count of each arm's edge set, the currency
// the S168 table is written in. Strays are not reported: only pages with more
// than K candidates are ranked at all, so each keeps K links in either arm and
// the stray set cannot move.
//
// Read-only apart from the embedding cache. Copy into <plugin>/src/, run, delete.
//
// | variable                | default                                  |
// |-------------------------|------------------------------------------|
// | LLM_WIKI_VAULT          | required                                 |
// | LLM_WIKI_FOLDER         | wiki                                     |
// | LLM_WIKI_LABEL_ENTITIES | Verwandte Entitaeten (with umlaut)       |
// | LLM_WIKI_LABEL_CONCEPTS | Verwandte Konzepte                       |
// | LLM_WIKI_EMBED_URL      | http://localhost:1234/v1/embeddings      |
// | LLM_WIKI_EMBED_MODEL    | text-embedding-bge-m3                    |
// | LLM_WIKI_EMBED_BATCH    | 32                                       |
// | LLM_WIKI_EMBED_CACHE    | ./embeddings-window.jsonl                |
// | LLM_WIKI_SEED           | 0                                        |

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, appendFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { execSync } from 'child_process';
import { parseFrontmatter } from './core/frontmatter';
import { rankAndCap, RELATED_CAP, type Folder, type RelatedRank } from './core/related-sections';
import { CANDIDATE_WINDOW_TEXT_CHARS } from './constants';

const VAULT = process.env.LLM_WIKI_VAULT!;
const WIKI = process.env.LLM_WIKI_FOLDER ?? 'wiki';
const LABELS = [
  process.env.LLM_WIKI_LABEL_ENTITIES ?? 'Verwandte Entitäten',
  process.env.LLM_WIKI_LABEL_CONCEPTS ?? 'Verwandte Konzepte',
];
const EMBED_URL = process.env.LLM_WIKI_EMBED_URL ?? 'http://localhost:1234/v1/embeddings';
const EMBED_MODEL = process.env.LLM_WIKI_EMBED_MODEL ?? 'text-embedding-bge-m3';
const EMBED_BATCH = Number(process.env.LLM_WIKI_EMBED_BATCH ?? 32);
const CACHE = process.env.LLM_WIKI_EMBED_CACHE ?? 'embeddings-window.jsonl';
const SEED = Number(process.env.LLM_WIKI_SEED ?? 0);
const K = RELATED_CAP;

interface Page {
  rel: string;          // `entities/Chrom`, the key both the rank and the links use
  title: string;
  into: Folder;
  sources: Set<string>; // `sources/<slug>`
  embedText: string;
}

// ---- embeddings -------------------------------------------------------------
// Same key and text form as embedding-window-probe, so the two share a cache
// and a page's vector is the same object in both measurements.

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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
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

const cos = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i];
  return s;
};

// ---- vault ------------------------------------------------------------------

const HEADING_RE = /^## (.+?)\s*$/;
const LINK_ALL_RE = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g;

/** `[[sources/X]]` or `sources/X` alike -> `sources/X`. */
const sourceKey = (s: string): string => s.replace(/^\[\[|\]\]$/g, '').split('|')[0].trim();

function loadPages(folder: Folder): Page[] {
  const dir = join(VAULT, WIKI, folder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
    const raw = readFileSync(join(dir, f), 'utf-8');
    const fm = parseFrontmatter(raw) ?? {};
    const body = raw.replace(/^---[\s\S]*?\n---\n?/, '');
    const title = f.replace(/\.md$/, '');
    return {
      rel: folder + '/' + title,
      title,
      into: folder,
      sources: new Set((Array.isArray(fm.sources) ? fm.sources.map(String) : []).map(sourceKey)),
      embedText: (title + '. ' + body).slice(0, CANDIDATE_WINDOW_TEXT_CHARS),
    };
  });
}

/**
 * The Related links a page carries, as `rel` keys. The provenance marker's own
 * link is stripped exactly as `keptEntries` strips it, or every marked entry
 * would contribute its source note as a candidate.
 */
function relatedOf(raw: string): string[] {
  const lines = raw.replace(/^---[\s\S]*?\n---\n?/, '').split('\n');
  const wanted = new Set(LABELS.map(l => l.trim()));
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const h = HEADING_RE.exec(line);
    if (h) { inSection = wanted.has(h[1].trim()); continue; }
    if (!inSection || !/^\s*[-*]\s+\[\[/.test(line)) continue;
    const bare = line.replace(/\^\[Quelle:\s*(?:\[\[[^\]]*\]\]|[^\]]*)\s*\]/g, '');
    for (const m of bare.matchAll(LINK_ALL_RE)) out.push(m[1].trim());
  }
  return out;
}

/** Deterministic shuffle, so the chance arm is reproducible. */
function shuffled<T>(xs: T[], seed: number): T[] {
  const out = [...xs];
  let s = seed || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const overlap = (a: string[], b: string[]): number => {
  const s = new Set(b);
  return a.reduce((n, x) => (s.has(x) ? n + 1 : n), 0);
};

function stats(xs: number[]): string {
  if (xs.length === 0) return 'n=0';
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return `n=${xs.length} mean ${mean.toFixed(2)} median ${s[Math.floor(s.length / 2)]}`;
}

/** Distinct unordered two-hop pairs an edge set implies. */
function twoHopPairs(edges: Map<string, string[]>): number {
  const pairs = new Set<string>();
  for (const targets of edges.values()) {
    for (let i = 0; i < targets.length; i++) {
      for (let j = i + 1; j < targets.length; j++) {
        pairs.add(targets[i] < targets[j] ? targets[i] + '|' + targets[j] : targets[j] + '|' + targets[i]);
      }
    }
  }
  return pairs.size;
}

describe('related rank probe', () => {
  it('can a meaning ranking pick a different Related list than the shipped one', async () => {
    let head = 'unknown';
    try {
      head = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim() +
        (execSync('git status --porcelain --untracked-files=no', { encoding: 'utf-8' }).trim() ? '+dirty' : '');
    } catch { /* not a checkout */ }

    const pages = [...loadPages('entities'), ...loadPages('concepts')];
    const byRel = new Map(pages.map(p => [p.rel, p]));
    console.log(JSON.stringify({
      probe: 'related-rank-probe', at: new Date().toISOString(), plugin: head, vault: VAULT,
      cap: K, embedModel: EMBED_MODEL, textChars: CANDIDATE_WINDOW_TEXT_CHARS, seed: SEED,
      pages: pages.length,
    }));

    // Candidates per page, resolvable only. A dead entry is dropped from BOTH
    // arms and counted, so neither arm is credited or charged for it.
    let dead = 0;
    const candidates = new Map<string, string[]>();
    for (const p of pages) {
      const raw = readFileSync(join(VAULT, WIKI, p.rel + '.md'), 'utf-8');
      const seen = new Set<string>();
      const kept: string[] = [];
      for (const rel of relatedOf(raw)) {
        if (rel === p.rel || seen.has(rel)) continue;
        seen.add(rel);
        if (byRel.has(rel)) kept.push(rel); else dead++;
      }
      candidates.set(p.rel, kept);
    }

    const contested = pages.filter(p => (candidates.get(p.rel) ?? []).length > K);
    console.log(`\n${pages.length} pages, ${dead} dead entries dropped, ` +
      `${contested.length} pages carry more than ${K} live candidates (only those can differ)`);

    loadCache();
    await embedAll(pages.map(p => p.embedText));

    const vecOf = (rel: string): number[] => vectors.get(key(byRel.get(rel)!.embedText)) ?? [];

    const byMeaning = (queryRel: string, cands: string[]): string[] => {
      const q = vecOf(queryRel);
      return cands
        .map((rel, i) => ({ rel, i, s: cos(q, vecOf(rel)) }))
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .slice(0, K)
        .map(x => x.rel);
    };

    const edgesS = new Map<string, string[]>();
    const edgesE = new Map<string, string[]>();
    const ovE: number[] = [], ovN: number[] = [], ovR: number[] = [];
    const ovSib: number[] = [], ovNonSib: number[] = [];
    let sibEntries = 0, allEntries = 0;
    // An overlap of 3 out of 5 is near-total agreement on a page with six
    // candidates and near-total disagreement on one with forty: two top-5 sets
    // drawn from n candidates must share at least 2K-n entries. So every
    // number below is also reported by candidate count, and against the floor
    // that arithmetic alone imposes.
    const buckets: Array<{ label: string; min: number; max: number; e: number[]; n: number[]; r: number[]; floor: number[] }> = [
      { label: '6-7 candidates', min: 6, max: 7, e: [], n: [], r: [], floor: [] },
      { label: '8-12', min: 8, max: 12, e: [], n: [], r: [], floor: [] },
      { label: '13 and up', min: 13, max: Infinity, e: [], n: [], r: [], floor: [] },
    ];
    const candCounts: number[] = [];

    pages.forEach((p, idx) => {
      const cands = candidates.get(p.rel) ?? [];
      const rank: RelatedRank = {
        pageSources: p.sources,
        sourcesOf: rel => byRel.get(rel)?.sources,
        // Unreachable here: every candidate resolves, so `sourcesOf` never
        // returns undefined and the born-from-this-note fallback never fires.
        sourceNote: ' none',
      };
      const entries = cands.map(rel => ({ rel, name: byRel.get(rel)!.title, into: byRel.get(rel)!.into }));
      const topS = rankAndCap(entries, rank, K).map(e => e.rel);
      const topE = byMeaning(p.rel, cands);
      edgesS.set(p.rel, topS);
      edgesE.set(p.rel, topE);

      allEntries += cands.length;
      const sib = cands.filter(rel => [...byRel.get(rel)!.sources].some(s => p.sources.has(s)));
      sibEntries += sib.length;

      if (cands.length <= K) return;
      const e = overlap(topS, topE);
      const n = overlap(topS, byMeaning(pages[(idx + 1) % pages.length].rel, cands));
      const r = overlap(topS, shuffled(cands, SEED + idx).slice(0, K));
      ovE.push(e); ovN.push(n); ovR.push(r);
      (sib.length === cands.length ? ovSib : ovNonSib).push(e);
      candCounts.push(cands.length);
      const b = buckets.find(x => cands.length >= x.min && cands.length <= x.max)!;
      b.e.push(e); b.n.push(n); b.r.push(r);
      b.floor.push(Math.max(0, 2 * K - cands.length));
    });

    console.log(`\nsiblings: ${sibEntries}/${allEntries} entries share a source with their page ` +
      `(${(100 * sibEntries / Math.max(allEntries, 1)).toFixed(1)} %)`);

    console.log(`\noverlap of the top ${K} with the shipped ranking, on the ${ovE.length} contested pages`);
    console.log(`  E meaning      ${stats(ovE)}`);
    console.log(`  N null vector  ${stats(ovN)}`);
    console.log(`  R shuffled     ${stats(ovR)}`);
    const identical = ovE.filter(x => x === K).length;
    console.log(`  identical lists: ${identical}/${ovE.length} (${(100 * identical / Math.max(ovE.length, 1)).toFixed(1)} %)`);

    const cc = [...candCounts].sort((a, b) => a - b);
    console.log(`  candidates on those pages: median ${cc[Math.floor(cc.length / 2)]}, max ${cc[cc.length - 1]}`);

    console.log(`\nby candidate count — "floor" is what two top-${K} sets must share by arithmetic alone`);
    for (const b of buckets) {
      if (b.e.length === 0) continue;
      const mean = (xs: number[]) => (xs.reduce((a, c) => a + c, 0) / xs.length).toFixed(2);
      console.log(`  ${b.label.padEnd(16)} n=${String(b.e.length).padStart(3)}  ` +
        `floor ${mean(b.floor)}  shuffled ${mean(b.r)}  null ${mean(b.n)}  meaning ${mean(b.e)}`);
    }

    console.log(`\n  pages whose candidates are ALL siblings   ${stats(ovSib)}`);
    console.log(`  pages with at least one non-sibling       ${stats(ovNonSib)}`);

    console.log(`\ntwo-hop pairs implied by the capped edge set`);
    console.log(`  S shipped   ${twoHopPairs(edgesS)}`);
    console.log(`  E meaning   ${twoHopPairs(edgesE)}`);

    expect(pages.length).toBeGreaterThan(0);
  }, 3_600_000);
});
