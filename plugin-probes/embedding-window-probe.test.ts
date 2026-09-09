// Embedding window against word window - same pool, same K, same run.
//
// The candidate window (#519/#520, core/candidate-window.ts) ranks the pages a
// dedup call gets to see by words: the item's name and summary against the
// page's own prose, with a document-frequency cap instead of a stop list. It
// lifted the target-in-window rate on the reference vault (S117), and the open
// question since S116 has been what a *meaning* ranking would do with the same
// slots - about 60 % of the targets are reached by no word index at all, so the
// ceiling of the word arm is not the ceiling of the window.
//
// This probe answers that and nothing else. Two arms over one pool:
//
//   W  word       `selectCandidateWindow` as shipped, dfCap 0.5 - the arm
//                 whose number is on record.
//   E  embedding  cosine between one vector for the item (name + summary) and
//                 one per page (the same character window of the page body the
//                 word arm reads), from an OpenAI-compatible /v1/embeddings
//                 endpoint. No reranking and no hybrid: a hybrid that wins says
//                 nothing about which half won.
//
// Both arms are asked for the FULL ordering, so the target's rank is readable
// even when it misses the window - an arm that moves a target from 400 to 45
// has found a signal that a hit rate at K hides.
//
// Two case sets, reported apart and never pooled - the same two the window
// probe uses, built the same way:
//
//   S  the synonym cases of ambiguity-cases.json that name a target. Hard,
//      hand-picked; a curated alias is stripped where the file says so, or the
//      resolver would answer without a call.
//   A  curated aliases hidden from the index. The item is the alias, its text
//      the first 300 chars of the page's first source NOTE - text the page did
//      not write itself. A trial the ConflictResolver decides never reaches
//      dedup and is counted out. Sampled with a fixed seed when there are more
//      aliases than LLM_WIKI_ALIAS_LIMIT, because every trial costs one
//      embedding; the seed fixes the draw only for one pool.
//
// Page vectors are cached by model + content, so a second run over the same
// vault embeds only the items. Nothing is written into the vault.
//
// Read-only apart from the cache. Copy into <plugin>/src/, run, delete.
//
// | variable                | default                                  |
// |-------------------------|------------------------------------------|
// | LLM_WIKI_VAULT          | required                                 |
// | LLM_WIKI_FOLDER         | wiki                                     |
// | LLM_WIKI_CASES          | <vault>/wiki/schema/ambiguity-cases.json |
// | LLM_WIKI_NOTE_FOLDERS   | Notizen,Frontier-Notizen                 |
// | LLM_WIKI_EMBED_URL      | http://localhost:1234/v1/embeddings      |
// | LLM_WIKI_EMBED_MODEL    | text-embedding-bge-m3                    |
// | LLM_WIKI_EMBED_BATCH    | 32                                       |
// | LLM_WIKI_EMBED_CACHE    | ./embeddings-window.jsonl                |
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
  strip_alias?: string;
}
interface Trial { label: string; name: string; summary: string; pool: Page[]; target: string; targetSources: number }

// ---- embeddings ------------------------------------------------------------

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

/** Embed every text not already cached; the cache is append-only, keyed by model + text. */
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

// ---- vault -----------------------------------------------------------------

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
      // The word arm reads the body lower-cased; the embedding arm reads the
      // same characters in their own casing, which is the form the encoder was
      // trained on. Same information, each arm in its own idiom.
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

/** Same-type pool exactly as resolvePagePath builds it. */
const sameTypePool = (pages: Page[]): Page[] =>
  pages.filter(p => !/^(entities|concepts|sources)([^\s\-_a-zA-Z0-9])/.test(p.title || ''));

/** Deterministic draw - the seed fixes it only for one pool. */
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

const itemText = (name: string, summary: string): string => (name + '. ' + summary).trim();

function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; }

function summarize(label: string, rows: Array<{ w: number; e: number }>): void {
  const n = rows.length;
  if (!n) return;
  console.log('\n' + label + ' - ' + n + ' trials, window ' + K);
  console.log('  arm            in-window    median rank   rank<=100');
  for (const [k, name] of [['w', 'W word'], ['e', 'E embedding']] as const) {
    const v = rows.map(r => r[k as 'w' | 'e']);
    const hit = v.filter(x => x <= K).length;
    const le = v.filter(x => x <= 100).length;
    const pct = (x: number): string => (100 * x / n).toFixed(1).padStart(5) + '%';
    console.log('  ' + name.padEnd(14) + ' ' + pct(hit) + ' (' + String(hit).padStart(4) + ')  ' +
      String(median(v)).padStart(7) + '       ' + pct(le));
  }
  const both = rows.filter(r => r.w <= K && r.e <= K).length;
  const wOnly = rows.filter(r => r.w <= K && r.e > K).length;
  const eOnly = rows.filter(r => r.e <= K && r.w > K).length;
  const none = rows.filter(r => r.w > K && r.e > K).length;
  console.log('  overlap: both ' + both + ', word only ' + wOnly + ', embedding only ' + eOnly + ', neither ' + none);
}

describe('embedding window probe', () => {
  it('does a meaning ranking put the target into the same slots', async () => {
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
      probe: 'embedding-window-probe', at: new Date().toISOString(), plugin: head, vault: VAULT, K,
      embedModel: EMBED_MODEL, textChars: CANDIDATE_WINDOW_TEXT_CHARS, aliasLimit: ALIAS_LIMIT, seed: SEED,
      pages: { entities: entities.length, concepts: concepts.length },
    }));

    loadCache();
    console.log('\nembedding ' + all.length + ' pages (cache ' + CACHE + ', ' + vectors.size + ' vectors already there)');
    await embedAll(all.map(p => p.embedText));

    const trials: Record<'S' | 'Ae' | 'Ac', Trial[]> = { S: [], Ae: [], Ac: [] };

    const cases = (JSON.parse(readFileSync(CASES, 'utf-8')) as { cases: Case[] }).cases
      .filter(c => c.expected.match && c.expected.title);
    for (const c of cases) {
      const pages = c.item.pageType === 'entity' ? entities : concepts;
      const target = pages.find(p => p.title === c.expected.title)?.path;
      if (!target) { console.log('  ' + c.id + '  CASE ERROR: "' + c.expected.title + '" not in the vault'); continue; }
      const strip = c.strip_alias?.toLowerCase();
      const pool = sameTypePool(strip ? pages.map(p => ({ ...p, aliases: p.aliases.filter(a => a.toLowerCase() !== strip) })) : pages);
      trials.S.push({ label: c.id + ' ' + c.item.name + ' -> ' + c.expected.title, name: c.item.name, summary: c.item.summary, pool, target, targetSources: pages.find(p => p.path === target)!.sources });
    }

    for (const [set, pages, pageType] of [['Ae', entities, 'entity'], ['Ac', concepts, 'concept']] as const) {
      const pool0 = sameTypePool(pages);
      const pairs: Array<{ p: Page; alias: string }> = [];
      for (const p of pool0) for (const alias of p.aliases) if (alias.trim()) pairs.push({ p, alias });
      let resolved = 0, noNote = 0;
      for (const pair of sample(pairs, ALIAS_LIMIT, SEED)) {
        const p = pair.p, alias = pair.alias;
        const hide = (q: Page): Page => q.path === p.path ? { ...q, aliases: q.aliases.filter(a => a !== alias) } : q;
        const cr = new ConflictResolver(WIKI, all.map(hide)).resolve({ name: alias, slug: slugify(alias, preserve), pageType, tags: [] });
        if (cr.action === 'merge' && !cr.reason.includes('Cross-type')) { resolved++; continue; }
        const summary = p.sourceText[0] ?? '';
        if (!summary) { noNote++; continue; }
        trials[set].push({ label: alias + ' -> ' + p.title, name: alias, summary, pool: pool0.map(hide), target: p.path, targetSources: p.sources });
      }
      console.log('\nSet A/' + pageType + ': ' + pairs.length + ' aliases, sampled ' + Math.min(pairs.length, ALIAS_LIMIT) +
        ', counted out ' + resolved + ' the resolver decides and ' + noNote + ' without a source note -> ' + trials[set].length + ' trials');
    }

    const everyTrial = [...trials.S, ...trials.Ae, ...trials.Ac];
    console.log('\nembedding ' + everyTrial.length + ' items');
    await embedAll(everyTrial.map(t => itemText(t.name, t.summary)));

    const rank = (t: Trial): { w: number; e: number } => {
      const w = selectCandidateWindow(
        { name: t.name, context: t.summary },
        t.pool.map(p => ({ path: p.path, title: p.title, aliases: p.aliases, text: p.text })),
        t.pool.length,
        { dfCap: 0.5 },
      ).findIndex(p => p.path === t.target) + 1;
      const q = vectors.get(key(itemText(t.name, t.summary)))!;
      const order = t.pool
        .map((p, i) => ({ p, s: cos(q, vectors.get(key(p.embedText)) ?? []), i }))
        .sort((a, b) => b.s - a.s || a.i - b.i);
      return { w, e: order.findIndex(x => x.p.path === t.target) + 1 };
    };

    // Null model: the same vectors, the wrong pairing. Each trial keeps its
    // pool and its target but is asked with the NEXT trial's item vector. A
    // rank measured against ~1000 pages says nothing until this line says what
    // no signal looks like.
    const nullRank = (ts: Trial[]): void => {
      if (ts.length < 2) return;
      const rows = ts.map((t, i) => {
        const q = vectors.get(key(itemText(ts[(i + 1) % ts.length].name, ts[(i + 1) % ts.length].summary)))!;
        const order = t.pool
          .map((p, j) => ({ p, s: cos(q, vectors.get(key(p.embedText)) ?? []), j }))
          .sort((a, b) => b.s - a.s || a.j - b.j);
        return order.findIndex(x => x.p.path === t.target) + 1;
      });
      const hit = rows.filter(x => x <= K).length;
      console.log('  null model (item of the next trial): in-window ' +
        (100 * hit / rows.length).toFixed(1) + '% (' + hit + '), median rank ' + median(rows) +
        ' of ' + ts[0].pool.length + ' pages');
    };

    console.log('\nSet S - synonym cases');
    const rowsS = trials.S.map(t => {
      const r = rank(t);
      console.log('  ' + t.label.padEnd(52) + ' W ' + String(r.w).padStart(5) + '   E ' + String(r.e).padStart(5));
      return r;
    });
    summarize('Set S - synonym cases', rowsS);
    for (const [set, name] of [['Ae', 'entities'], ['Ac', 'concepts']] as const) {
      const ts = trials[set];
      summarize('Set A - ' + name + ' alias trials', ts.map(rank));
      // The control the numbers above need: on a ONE-SOURCE page the item text
      // is the first paragraph of the very note the page was written from, so
      // a vector that finds it may be recognising provenance rather than
      // meaning - the same shape as the S168 sibling tautology. On a page with
      // several sources the body is a merge, and the first note is one voice
      // among many. Read the multi-source block as the finding.
      const one = ts.filter(t => t.targetSources <= 1);
      const many = ts.filter(t => t.targetSources > 1);
      summarize('  ' + name + ', target has ONE source (provenance is enough)', one.map(rank));
      summarize('  ' + name + ', target has SEVERAL sources (the control)', many.map(rank));
      nullRank(ts);
    }
  }, 3_600_000);
});
