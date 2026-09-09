// Does a meaning-ranked window make the model merge things it should not?
//
// The window half of this question is answered (precision-window-probe): the
// distributions do not separate. Take a page out of the vault and the nearest
// remaining page is, on average, as close to the item as the right page was -
// median cosine 0.700 against 0.691 on entities, 0.689 against 0.673 on
// concepts, both far above a null pairing at 0.45. So a floor on the RAW cosine
// barely tells "this item has a page" from "this item has none" - and that null
// pairing at 0.45 is why: most of the number is the corpus, not the pair.
// abstention-statistic-probe takes the constant out and the floor improves
// without becoming good (13.2 % to 21.7 % abstention at 95 % of targets kept,
// overlap 87 % to 78 %). A window-side rule is therefore weak, not impossible,
// and the other place a rule could live is the model.
//
// This probe asks it. Two arms that differ in ONE thing - which thirty pages
// the dedup call is shown:
//
//   W  `selectDedupCandidates` as shipped (selectCandidateWindow, top 30).
//   E  the top 30 by cosine over the same pool, same K, same order format.
//
// Everything else is the production path: PROMPTS.resolveEntityDedup rendered
// with the same variables resolvePagePath passes, the 'index' system prompt via
// SchemaManager, TOKENS_DEDUP_RESOLUTION, json_schema at the wire, the vault's
// own temperature.
//
// Three item sets, and the pairing is the point:
//
//   Z+  an alias whose page IS in the vault. Correct answer: that page.
//   Z-  the SAME alias and the SAME text, with its page removed from the pool.
//       Correct answer: no match. Identical item, different vault - so a
//       difference between Z+ and Z- is the vault, not the wording.
//   N   the negative cases of ambiguity-cases.json. Correct answer: no match.
//
// Both directions are needed or the measurement is worthless: an arm scored
// only on Z-/N is won by answering "no match" every time, and an arm scored
// only on Z+ is won by merging everything. The pair states precision and
// recall against each other, per arm.
//
// Trials are drawn stratified by the Z- top-1 cosine, so the easy and the
// tempting end are both represented rather than averaged away.
//
// ⚠ Pool order: production sorts the candidate pool by file ctime, for the KV
// prefix cache. In an unpacked archive ctime is the unpacking time, so this
// probe sorts by the `created:` field instead (day resolution, readdir order
// among equals). Scored candidates are unaffected; only the order of the
// score-0 tail differs from production, in the W arm.
//
// Writes one JSONL record per call. Read-only on the vault otherwise.
// Copy into <plugin>/src/, run, delete.
//
// | variable                | default                                  |
// |-------------------------|------------------------------------------|
// | LLM_WIKI_VAULT          | required                                 |
// | LLM_WIKI_MODEL          | plugin data.json model                   |
// | LLM_WIKI_BASE_URL       | plugin data.json baseUrl                 |
// | LLM_WIKI_TEMPERATURE    | 0.15                                     |
// | LLM_WIKI_PAIRS          | 6 per page type                          |
// | LLM_WIKI_EMBED_CACHE    | ./embeddings-window.jsonl                |
// | LLM_WIKI_OUT            | ./precision-model.jsonl                  |
// | LLM_WIKI_DRY            | 1 = build prompts, call nothing          |

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, appendFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { execSync } from 'child_process';
import { TFile } from 'obsidian';
import { PROMPTS } from './prompts';
import { DEFAULT_SETTINGS, type LLMWikiSettings } from './types';
import { slugify } from './core/slug';
import { parseFrontmatter } from './core/frontmatter';
import { ConflictResolver } from './core/conflict-resolver';
import { selectDedupCandidates } from './wiki/page-factory/path-resolution';
import { buildSystemPrompt } from './wiki/system-prompts';
import { SchemaManager } from './schema/schema-manager';
import { renderTemplate } from './core/template-renderer';
import { TOKENS_DEDUP_RESOLUTION, DEDUP_CANDIDATE_TOP_K, CANDIDATE_WINDOW_TEXT_CHARS } from './constants';
import { sourceBaseSlug } from './core/source-slug';

const VAULT = process.env.LLM_WIKI_VAULT!;
const WIKI = process.env.LLM_WIKI_FOLDER ?? 'wiki';
const CASES = process.env.LLM_WIKI_CASES ?? join(VAULT, WIKI, 'schema', 'ambiguity-cases.json');
const NOTE_FOLDERS = (process.env.LLM_WIKI_NOTE_FOLDERS ?? 'Notizen,Frontier-Notizen').split(',').map(s => s.trim()).filter(Boolean);
const EMBED_URL = process.env.LLM_WIKI_EMBED_URL ?? 'http://localhost:1234/v1/embeddings';
const EMBED_MODEL = process.env.LLM_WIKI_EMBED_MODEL ?? 'text-embedding-bge-m3';
const CACHE = process.env.LLM_WIKI_EMBED_CACHE ?? 'embeddings-window.jsonl';
const OUT = process.env.LLM_WIKI_OUT ?? './precision-model.jsonl';
const TEMPERATURE = Number(process.env.LLM_WIKI_TEMPERATURE ?? 0.15);
const PAIRS = Number(process.env.LLM_WIKI_PAIRS ?? 6);
const ALIAS_LIMIT = Number(process.env.LLM_WIKI_ALIAS_LIMIT ?? 200);
const SEED = Number(process.env.LLM_WIKI_SEED ?? 0);
const DRY = process.env.LLM_WIKI_DRY === '1';
const K = DEDUP_CANDIDATE_TOP_K;

type PageType = 'entity' | 'concept';
interface Page { path: string; title: string; aliases: string[]; text: string; embedText: string; sourceText: string[]; created: string }
interface Case {
  id: string; class: string;
  item: { name: string; pageType: PageType; type: string; summary: string; domains: string[] };
  expected: { match: boolean; title?: string };
  expected_note?: string;
  strip_alias?: string;
}

// ---- embeddings: read the cache the window probe filled, never extend it ---

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
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map(x => x / n);
}
async function embedAll(texts: string[]): Promise<void> {
  const todo = [...new Set(texts)].filter(t => t.trim() && !vectors.has(key(t)));
  for (let i = 0; i < todo.length; i += 32) {
    const batch = todo.slice(i, i + 32);
    const res = await fetch(EMBED_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: batch }),
    });
    if (!res.ok) throw new Error('embeddings ' + res.status + ': ' + (await res.text()));
    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    const lines: string[] = [];
    batch.forEach((t, j) => { const v = unit(data.data[j].embedding); vectors.set(key(t), v); lines.push(JSON.stringify({ k: key(t), v })); });
    appendFileSync(CACHE, lines.join('\n') + '\n');
  }
}
function cos(a: number[], b: number[]): number {
  let s = 0; for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i]; return s;
}

// ---- vault ----------------------------------------------------------------

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
    return {
      path: WIKI + '/' + folder + '/' + f,
      title: f.replace(/\.md$/, ''),
      aliases: Array.isArray(fm.aliases) ? fm.aliases.map(String) : [],
      text: body.toLowerCase().slice(0, CANDIDATE_WINDOW_TEXT_CHARS),
      embedText: (f.replace(/\.md$/, '') + '. ' + body).slice(0, CANDIDATE_WINDOW_TEXT_CHARS),
      sourceText: sources.map(s => { const m = /sources\/([^\]|]+)/.exec(s); return m ? noteText(m[1].trim(), preserve) : ''; }),
      created: typeof fm.created === 'string' ? fm.created : '',
    };
  });
}

const sameTypePool = (pages: Page[]): Page[] =>
  pages.filter(p => !/^(entities|concepts|sources)([^\s\-_a-zA-Z0-9])/.test(p.title || ''))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.created < b.p.created ? -1 : a.p.created > b.p.created ? 1 : a.i - b.i))
    .map(x => x.p);

function sample<T>(xs: T[], n: number, seed: number): T[] {
  if (xs.length <= n) return xs;
  let s = seed || 1;
  const rnd = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = out[i]; out[i] = out[j]; out[j] = t; }
  return out.slice(0, n);
}

const itemText = (name: string, summary: string): string => (name + '. ' + summary).trim();
const line = (p: Page): string => '- path: ' + p.path + '\n  title: ' + p.title + (p.aliases.length ? '\n  aliases: ' + p.aliases.join(', ') : '');
const basenameOf = (p: string): string => p.replace(/^\[\[|\]\]$/g, '').split('/').pop()!.replace(/\.md$/i, '');

const JSON_SCHEMA = {
  name: 'path_resolution',
  schema: { type: 'object', properties: { match: { type: 'boolean' }, path: { type: ['string', 'null'] } }, additionalProperties: true },
};

async function callModel(baseUrl: string, model: string, system: string | undefined, user: string) {
  const t0 = Date.now();
  const res = await fetch(baseUrl.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }],
      temperature: TEMPERATURE, max_tokens: TOKENS_DEDUP_RESOLUTION,
      response_format: { type: 'json_schema', json_schema: JSON_SCHEMA },
    }),
  });
  const ms = Date.now() - t0;
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: Record<string, unknown>; error?: unknown };
  const content = body.choices?.[0]?.message?.content ?? '';
  let parsed: { match?: unknown; path?: unknown } | null = null;
  try { parsed = JSON.parse(content); } catch { parsed = null; }
  return { ms, content, parsed, usage: body.usage, error: body.error };
}

interface Item {
  id: string; set: 'Z+' | 'Z-' | 'N'; name: string; summary: string; pageType: PageType;
  pool: Page[]; expect: string | null; note?: string; topCos?: number;
}

describe('precision model probe', () => {
  it('two windows, one prompt, both directions', async () => {
    expect(VAULT, 'set LLM_WIKI_VAULT').toBeTruthy();
    const settings = loadSettings();
    const baseUrl = process.env.LLM_WIKI_BASE_URL ?? (settings as unknown as { baseUrl?: string }).baseUrl ?? 'http://localhost:1234/v1';
    const model = process.env.LLM_WIKI_MODEL ?? settings.model;
    const preserve = settings.slugCase === 'preserve';
    const entities = loadPages('entities', preserve);
    const concepts = loadPages('concepts', preserve);
    const all = [...entities, ...concepts];

    const fakeApp = {
      vault: {
        getAbstractFileByPath: (p: string) => existsSync(join(VAULT, p)) ? Object.assign(new TFile(), { path: p }) : null,
        read: async (f: { path: string }) => readFileSync(join(VAULT, f.path), 'utf-8'),
      },
    };
    const sm = new SchemaManager(fakeApp as never, settings, () => null);
    const system = await buildSystemPrompt(settings, (task) => sm.getSchemaContext(task as never), 'index');

    let head = 'unknown';
    try {
      head = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim() +
        (execSync('git status --porcelain --untracked-files=no', { encoding: 'utf-8' }).trim() ? '+dirty' : '');
    } catch { /* not a checkout */ }
    const header = {
      probe: 'precision-model-probe', at: new Date().toISOString(), plugin: head, vault: VAULT,
      model, baseUrl, temperature: TEMPERATURE, embedModel: EMBED_MODEL, K, pairs: PAIRS, seed: SEED,
      pages: { entities: entities.length, concepts: concepts.length }, systemPromptChars: system?.length ?? 0,
    };
    console.log(JSON.stringify(header));

    loadCache();
    console.log('cache: ' + vectors.size + ' vectors');

    // ---- build the paired alias trials, same draw as the window probe -----
    const items: Item[] = [];
    for (const [pages, pageType] of [[entities, 'entity'], [concepts, 'concept']] as const) {
      const pool0 = sameTypePool(pages);
      const pairs: Array<{ p: Page; alias: string }> = [];
      for (const p of pool0) for (const alias of p.aliases) if (alias.trim()) pairs.push({ p, alias });
      const cands: Array<{ p: Page; alias: string; summary: string; pool: Page[] }> = [];
      for (const pair of sample(pairs, ALIAS_LIMIT, SEED)) {
        const p = pair.p, alias = pair.alias;
        const hide = (x: Page): Page => x.path === p.path ? { ...x, aliases: x.aliases.filter(a => a !== alias) } : x;
        const cr = new ConflictResolver(WIKI, all.map(hide)).resolve({ name: alias, slug: slugify(alias, preserve), pageType, tags: [] });
        if (cr.action === 'merge' && !cr.reason.includes('Cross-type')) continue;
        const summary = p.sourceText[0] ?? '';
        if (!summary) continue;
        cands.push({ p, alias, summary, pool: pool0.map(hide) });
      }
      await embedAll(cands.map(c => itemText(c.alias, c.summary)));
      // Stratify by the Z- top-1 cosine: the tempting end must be in the draw.
      const scored = cands.map(c => {
        const q = vectors.get(key(itemText(c.alias, c.summary)))!;
        const minus = c.pool.filter(x => x.path !== c.p.path);
        let best = -1;
        for (const x of minus) { const s = cos(q, vectors.get(key(x.embedText)) ?? []); if (s > best) best = s; }
        return { ...c, topCos: best };
      }).sort((a, b) => a.topCos - b.topCos);
      for (let j = 0; j < PAIRS; j++) {
        const c = scored[Math.min(scored.length - 1, Math.floor((j + 0.5) * scored.length / PAIRS))];
        const id = pageType[0].toUpperCase() + (j + 1);
        items.push({ id, set: 'Z+', name: c.alias, summary: c.summary, pageType, pool: c.pool, expect: c.p.path, topCos: c.topCos });
        items.push({ id, set: 'Z-', name: c.alias, summary: c.summary, pageType, pool: c.pool.filter(x => x.path !== c.p.path), expect: null, topCos: c.topCos });
      }
    }

    // ---- the negative cases ------------------------------------------------
    for (const c of (JSON.parse(readFileSync(CASES, 'utf-8')) as { cases: Case[] }).cases.filter(x => !x.expected.match)) {
      const pages = c.item.pageType === 'entity' ? entities : concepts;
      const strip = c.strip_alias?.toLowerCase();
      const hidden = strip ? pages.map(p => ({ ...p, aliases: p.aliases.filter(a => a.toLowerCase() !== strip) })) : pages;
      items.push({ id: c.id, set: 'N', name: c.item.name, summary: c.item.summary, pageType: c.item.pageType, pool: sameTypePool(hidden), expect: null, note: c.expected_note });
    }
    await embedAll(items.map(i => itemText(i.name, i.summary)));

    // ---- the two windows ---------------------------------------------------
    const windows = (i: Item): { W: Page[]; E: Page[] } => {
      const W = selectDedupCandidates(i.name, i.summary, i.pool as never) as unknown as Page[];
      const q = vectors.get(key(itemText(i.name, i.summary)))!;
      const E = i.pool.map((p, n) => ({ p, s: cos(q, vectors.get(key(p.embedText)) ?? []), n }))
        .sort((a, b) => b.s - a.s || a.n - b.n).slice(0, K).map(x => x.p);
      return { W, E };
    };

    writeFileSync(OUT, JSON.stringify({ header }) + '\n');
    const verdict = (i: Item, parsed: { match?: unknown; path?: unknown } | null): string => {
      if (!parsed) return 'unreadable';
      const matched = parsed.match === true && typeof parsed.path === 'string' && parsed.path.trim();
      if (!matched) return i.expect ? 'missed' : 'correct-nomatch';
      const bn = basenameOf(String(parsed.path));
      if (i.expect) return bn === basenameOf(i.expect) ? 'correct-match' : 'wrong-page:' + bn;
      return 'FALSE-MERGE:' + bn;
    };

    const tally: Record<string, Record<string, number>> = {};
    const bump = (arm: string, set: string, v: string): void => {
      const k = arm + ' ' + set; tally[k] = tally[k] ?? {};
      const c = v.split(':')[0]; tally[k][c] = (tally[k][c] ?? 0) + 1;
    };

    let n = 0;
    for (const i of items) {
      const w = windows(i);
      for (const arm of ['W', 'E'] as const) {
        const list = w[arm];
        const targetInWindow = i.expect ? list.some(p => p.path === i.expect) : null;
        const prompt = renderTemplate(PROMPTS.resolveEntityDedup, {
          wikiFolder: settings.wikiFolder, entity_name: i.name, entity_type: i.pageType,
          entity_summary: i.summary.substring(0, 300), page_type: i.pageType,
          existing_pages: list.map(line).join('\n'),
        });
        n++;
        if (DRY) { if (n === 1) console.log('\n===== SYSTEM =====\n' + system + '\n===== PROMPT =====\n' + prompt); continue; }
        const r = await callModel(baseUrl, model, system, prompt);
        const v = verdict(i, r.parsed);
        bump(arm, i.set, v);
        appendFileSync(OUT, JSON.stringify({
          id: i.id, set: i.set, arm, name: i.name, pageType: i.pageType, expect: i.expect,
          targetInWindow, topCos: i.topCos, verdict: v, ms: r.ms, content: r.content, usage: r.usage,
        }) + '\n');
        console.log(String(n).padStart(3) + '/' + items.length * 2 + '  ' + (i.id + ' ' + i.set).padEnd(9) + arm +
          '  ' + i.name.slice(0, 30).padEnd(30) + (targetInWindow === null ? '     ' : targetInWindow ? ' in  ' : ' OUT ') +
          v.padEnd(28) + (r.ms / 1000).toFixed(1) + 's');
      }
    }
    if (DRY) return;

    console.log('\n=== tally: verdicts per arm and set');
    for (const k of Object.keys(tally).sort()) {
      console.log('  ' + k.padEnd(6) + ' ' + Object.entries(tally[k]).map(([v, c]) => v + ' ' + c).join(', '));
    }
    const rate = (arm: string, sets: string[], cat: string): string => {
      let hit = 0, tot = 0;
      for (const s of sets) { const t = tally[arm + ' ' + s] ?? {}; for (const [v, c] of Object.entries(t)) { tot += c; if (v === cat) hit += c; } }
      return tot ? (100 * hit / tot).toFixed(0) + ' % (' + hit + '/' + tot + ')' : '-';
    };
    console.log('\n=== the two numbers that trade against each other');
    console.log('  arm   false merges (Z- and N)      targets found (Z+)');
    for (const arm of ['W', 'E']) {
      console.log('   ' + arm + '    ' + rate(arm, ['Z-', 'N'], 'FALSE-MERGE').padEnd(28) + rate(arm, ['Z+'], 'correct-match'));
    }
  }, 7_200_000);
});
