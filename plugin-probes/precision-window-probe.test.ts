// The precision arm: what a window offers when the item has NO page.
//
// The recall arm (embedding-window-probe, S170) asked where a known target
// lands and answered it: a meaning ranking puts it in the window 99.5 / 95.1 %
// of the time against 56.1 / 33.9 % for words. Every trial there had a target.
//
// In production most items do not. An extracted item is usually a new thing,
// or a thing the vault names in passing, or a section heading; the page it
// should merge into does not exist. `core/candidate-window.ts` has no floor -
// it says so in its own header: "The window is always K pages, or the whole
// pool when it is smaller: pages without any signal fill the tail in pool
// order". So both arms always return K pages. The difference is WHAT they
// return when they know nothing:
//
//   W  a no-signal window is pool order - the tail is arbitrary, and a caller
//      can see that it is arbitrary.
//   E  a no-signal window is still the K nearest pages in the vault. Every one
//      of them is the most plausible wrong answer available.
//
// That is the risk this probe measures, and the reason it must be measured
// before a rebuild: a denser window may buy recall and pay for it in merges
// that should never have been offered.
//
// Three populations, one pool, one run, no model calls:
//
//   Z+  target present.  The alias trials of the recall arm, unchanged.
//       Statistic: the TARGET's own score, and its rank.
//   Z-  target absent.   The same trials with the target page REMOVED from the
//       pool. The item now provably has no page, and the item text is real
//       vault prose rather than something written for the occasion.
//       Statistic: the TOP-1's score - the best wrong answer.
//   F   foreign domain.  Constructed items from fields this vault does not
//       cover. A sanity floor, not a headline: the text is written for the
//       probe, so it says what "nothing to do with this vault" looks like and
//       nothing about how often that happens.
//
// The abstention question is then a single comparison. A floor t drops every
// candidate scoring below it. On Z+ that is a LOSS when the target falls
// below t; on Z- and F it is a correct empty window. An abstention rule exists
// only if those distributions separate. If they overlap, the rule cannot live
// in the window and has to come from the model - which is a finding, not a
// failure.
//
// The word arm gets the identical treatment, plus one measure it alone can
// carry: whether its top-1 is determined by signal at all. Ties keep pool
// order, so the same query over a SHUFFLED pool returns a different top-1
// exactly when the leader was not uniquely scored. That is the arm declaring
// its own ignorance - the property the embedding arm structurally cannot have.
//
// Also printed: the negative cases of ambiguity-cases.json (N*, H*) with the
// top 5 of each arm, so the near-miss neighbours can be read rather than
// pre-declared. Whether the ConflictResolver decides a case before any window
// exists is checked against the resolver, not taken from the S115 write-up.
//
// Read-only apart from the embedding cache. Copy into <plugin>/src/, run, delete.
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

// Constructed items from fields this vault does not cover. Written for the
// probe: they say what "nothing here" looks like, not how often it happens.
const FOREIGN: Array<{ name: string; summary: string; pageType: PageType }> = [
  { name: 'Skaldische Dichtung', pageType: 'concept', summary: 'Altnordische Hofdichtung des 9. bis 13. Jahrhunderts mit strenger Silbenzählung, Stabreim und Binnenreim; kenningreiche Umschreibungen ersetzen das einfache Wort, überliefert vor allem in isländischen Königssagas.' },
  { name: 'Zargenbiegung', pageType: 'concept', summary: 'Arbeitsschritt im Streichinstrumentenbau, bei dem die dünnen Seitenwände eines Korpus über einem beheizten Biegeeisen befeuchtet und in die Form gezwungen und anschließend im Zargenkranz fixiert werden.' },
  { name: 'Achszähler', pageType: 'entity', summary: 'Eisenbahnsicherungstechnik zur Gleisfreimeldung: Sensoren an Anfang und Ende eines Abschnitts zählen die passierenden Radsätze, und erst bei gleicher Zahl gilt der Abschnitt wieder als frei.' },
  { name: 'Turmspringen', pageType: 'concept', summary: 'Wassersportdisziplin von festen Plattformen in drei, fünf, siebeneinhalb und zehn Metern Höhe; bewertet werden Absprung, Flugbild, Drehungen und das Eintauchen mit möglichst geringem Spritzer.' },
  { name: 'Kalben eines Gletschers', pageType: 'concept', summary: 'Abbruch von Eisbergen an der Front eines ins Meer mündenden Gletschers; die Rate hängt von Wassertiefe, Gezeitenhub und der Temperatur des anstehenden Meerwassers ab.' },
  { name: 'Zugzwang', pageType: 'concept', summary: 'Situation im Schachendspiel, in der jede verfügbare Fortsetzung die eigene Stellung verschlechtert; die Pflicht zu ziehen wird zum Nachteil, was Opposition und Dreiecksmanöver zur Gewinnmethode macht.' },
  { name: 'Opus caementicium', pageType: 'entity', summary: 'Römischer Gussmörtel aus gebranntem Kalk, vulkanischer Puzzolanerde und Bruchsteinzuschlag; er band auch unter Wasser ab und trug Kuppeln, Hafenmolen und Aquädukte.' },
  { name: 'Tritonus-Substitution', pageType: 'concept', summary: 'Harmonielehre des Jazz: ein Dominantseptakkord wird durch den im Tritonus entfernten ersetzt, weil beide denselben Tritonus aus Terz und Septime enthalten, was chromatisch absteigende Bassläufe erlaubt.' },
  { name: 'Buchbinderleinen', pageType: 'entity', summary: 'Mit Stärke oder Kunstharz beschichtetes Gewebe zum Beziehen von Buchdeckeln; es muss den Falz mehrere tausend Öffnungen überstehen und wird nach Fadenzahl und Griffbild ausgewählt.' },
  { name: 'Progressive Abschreibung', pageType: 'concept', summary: 'Steuerrechtliches Verfahren, bei dem die jährlichen Abschreibungsbeträge über die Nutzungsdauer steigen; in vielen Rechtsordnungen unzulässig, weil der Werteverzehr typischerweise am Anfang am größten ist.' },
];

describe('precision window probe', () => {
  it('what does each arm offer when the item has no page', async () => {
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
      probe: 'precision-window-probe', at: new Date().toISOString(), plugin: head, vault: VAULT, K,
      embedModel: EMBED_MODEL, textChars: CANDIDATE_WINDOW_TEXT_CHARS, aliasLimit: ALIAS_LIMIT, seed: SEED,
      pages: { entities: entities.length, concepts: concepts.length },
    }));

    loadCache();
    console.log('\nembedding ' + all.length + ' pages (cache ' + CACHE + ', ' + vectors.size + ' vectors already there)');
    await embedAll(all.map(p => p.embedText));

    // ---- the alias trials, exactly as the recall arm draws them ------------
    const trials: Record<'Ae' | 'Ac', Trial[]> = { Ae: [], Ac: [] };
    for (const [set, pages, pageType] of [['Ae', entities, 'entity'], ['Ac', concepts, 'concept']] as const) {
      const pool0 = sameTypePool(pages);
      const pairs: Array<{ p: Page; alias: string }> = [];
      for (const p of pool0) for (const alias of p.aliases) if (alias.trim()) pairs.push({ p, alias });
      let resolved = 0, noNote = 0;
      for (const pair of sample(pairs, ALIAS_LIMIT, SEED)) {
        const p = pair.p, alias = pair.alias;
        const hide = (x: Page): Page => x.path === p.path ? { ...x, aliases: x.aliases.filter(a => a !== alias) } : x;
        const cr = new ConflictResolver(WIKI, all.map(hide)).resolve({ name: alias, slug: slugify(alias, preserve), pageType, tags: [] });
        if (cr.action === 'merge' && !cr.reason.includes('Cross-type')) { resolved++; continue; }
        const summary = p.sourceText[0] ?? '';
        if (!summary) { noNote++; continue; }
        trials[set].push({ label: alias + ' -> ' + p.title, name: alias, summary, pool: pool0.map(hide), target: p.path, targetSources: p.sources });
      }
      console.log('\nSet ' + pageType + ': ' + pairs.length + ' aliases, sampled ' + Math.min(pairs.length, ALIAS_LIMIT) +
        ', counted out ' + resolved + ' resolver-decided and ' + noNote + ' without a source note -> ' + trials[set].length + ' trials');
    }

    const everyTrial = [...trials.Ae, ...trials.Ac];
    const negCases = (JSON.parse(readFileSync(CASES, 'utf-8')) as { cases: Case[] }).cases.filter(c => !c.expected.match);
    console.log('\nembedding ' + (everyTrial.length + FOREIGN.length + negCases.length) + ' items');
    await embedAll([
      ...everyTrial.map(t => itemText(t.name, t.summary)),
      ...FOREIGN.map(t => itemText(t.name, t.summary)),
      ...negCases.map(c => itemText(c.item.name, c.item.summary)),
    ]);

    // ---- the three populations --------------------------------------------
    for (const [set, name, pages] of [['Ae', 'entities', entities], ['Ac', 'concepts', concepts]] as const) {
      const ts = trials[set];
      if (!ts.length) continue;
      const pool0 = sameTypePool(pages);

      const zPlusE: number[] = [], zPlusW: number[] = [], zPlusRank: number[] = [];
      const zMinusE: number[] = [];
      let wArbitraryPlus = 0, wArbitraryMinus = 0;
      const nullE: number[] = [];
      const examples: string[] = [];

      ts.forEach((t, i) => {
        // Z+ : the target's own score.
        const eOrder = embedOrder(q(t), t.pool);
        const eAt = eOrder.findIndex(x => x.p.path === t.target);
        zPlusE.push(eOrder[eAt].s);
        zPlusRank.push(eAt + 1);
        const w = wordOrder(t.name, t.summary, t.pool);
        zPlusW.push(w.order.findIndex(p => p.path === t.target) + 1);
        if (w.arbitraryLead) wArbitraryPlus++;

        // Z- : the same item, the target taken out of the vault.
        const poolMinus = t.pool.filter(p => p.path !== t.target);
        const eMinus = embedOrder(q(t), poolMinus);
        zMinusE.push(eMinus[0].s);
        const wMinus = wordOrder(t.name, t.summary, poolMinus);
        if (wMinus.arbitraryLead) wArbitraryMinus++;
        if (examples.length < 12) {
          examples.push('    ' + t.label.padEnd(46) + ' E top-1 without it: ' +
            f3(eMinus[0].s) + '  ' + eMinus[0].p.title.slice(0, 34).padEnd(34) +
            ' | W top-1 ' + (wMinus.arbitraryLead ? 'arbitrary' : wMinus.order[0].title.slice(0, 24)));
        }

        // Null: the target's cosine under the wrong item.
        const other = ts[(i + 1) % ts.length];
        const nOrder = embedOrder(q(other), t.pool);
        nullE.push(nOrder[nOrder.findIndex(x => x.p.path === t.target)].s);
      });

      console.log('\n=== ' + name + ' - ' + ts.length + ' trials, pool ' + pool0.length + ', window ' + K);
      const qp = quantiles(zPlusE), qm = quantiles(zMinusE), qn = quantiles(nullE);
      console.log('  E cosine            p5     p25     med     p75     p95');
      console.log('   Z+ target      ' + f3(qp.p5) + '  ' + f3(qp.p25) + '  ' + f3(qp.med) + '  ' + f3(qp.p75) + '  ' + f3(qp.p95));
      console.log('   Z- best wrong  ' + f3(qm.p5) + '  ' + f3(qm.p25) + '  ' + f3(qm.med) + '  ' + f3(qm.p75) + '  ' + f3(qm.p95));
      console.log('   null pairing   ' + f3(qn.p5) + '  ' + f3(qn.p25) + '  ' + f3(qn.med) + '  ' + f3(qn.p75) + '  ' + f3(qn.p95));

      // The abstention curve: keep x % of targets, abstain how often?
      console.log('\n  a floor t on the cosine - what it keeps and what it stops');
      console.log('   keep targets   t       Z- empty   F empty');
      const sortedPlus = [...zPlusE].sort((a, b) => a - b);
      const fTop = FOREIGN.filter(f => (f.pageType === 'entity') === (name === 'entities'))
        .map(f => embedOrder(q(f), pool0)[0].s);
      for (const keep of [0.99, 0.95, 0.90, 0.80]) {
        const t = sortedPlus[Math.max(0, Math.floor((1 - keep) * sortedPlus.length))];
        const zm = zMinusE.filter(x => x < t).length;
        const fe = fTop.filter(x => x < t).length;
        console.log('     ' + (100 * keep).toFixed(0).padStart(3) + ' %      ' + f3(t) +
          '   ' + (100 * zm / zMinusE.length).toFixed(1).padStart(5) + ' %    ' +
          (fTop.length ? (100 * fe / fTop.length).toFixed(0).padStart(4) + ' % (' + fe + '/' + fTop.length + ')' : '   -'));
      }

      const inWin = zPlusRank.filter(r => r <= K).length;
      console.log('\n  W word arm: target in window ' + zPlusW.filter(r => r <= K).length + '/' + ts.length +
        ', E ' + inWin + '/' + ts.length + '  (the recall arm, reproduced)');
      console.log('  W top-1 not determined by score: Z+ ' + (100 * wArbitraryPlus / ts.length).toFixed(1) + ' %, Z- ' +
        (100 * wArbitraryMinus / ts.length).toFixed(1) + ' %   <- the word arm declaring its own ignorance');
      console.log('\n  twelve Z- trials, read by hand:');
      examples.forEach(e => console.log(e));
    }

    // ---- foreign-domain items ---------------------------------------------
    console.log('\n=== F - constructed foreign-domain items (a floor, not a rate)');
    for (const f of FOREIGN) {
      const pool = sameTypePool(f.pageType === 'entity' ? entities : concepts);
      const o = embedOrder(q(f), pool);
      const w = wordOrder(f.name, f.summary, pool);
      console.log('  ' + f.name.padEnd(26) + ' E ' + f3(o[0].s) + ' ' + o[0].p.title.slice(0, 30).padEnd(30) +
        ' | W ' + (w.arbitraryLead ? 'arbitrary' : w.order[0].title.slice(0, 26)));
    }

    // ---- the negative cases of the case file -------------------------------
    console.log('\n=== negative cases of ambiguity-cases.json - top 5 per arm');
    for (const c of negCases) {
      const pages = c.item.pageType === 'entity' ? entities : concepts;
      const strip = c.strip_alias?.toLowerCase();
      const hidden = strip ? pages.map(p => ({ ...p, aliases: p.aliases.filter(a => a.toLowerCase() !== strip) })) : pages;
      const pool = sameTypePool(hidden);
      const cr = new ConflictResolver(WIKI, [...(c.item.pageType === 'entity' ? hidden : entities), ...(c.item.pageType === 'concept' ? hidden : concepts)])
        .resolve({ name: c.item.name, slug: slugify(c.item.name, preserve), pageType: c.item.pageType, tags: [] });
      const decided = cr.action === 'merge';
      console.log('\n  ' + c.id + ' ' + c.item.name + '  [' + c.class + ']' +
        (decided ? '  RESOLVER DECIDES BEFORE ANY WINDOW: ' + cr.action + ' - ' + cr.reason : ''));
      if (c.expected_note) console.log('      note: ' + c.expected_note);
      const o = embedOrder(q(c.item), pool).slice(0, 5);
      const w = wordOrder(c.item.name, c.item.summary, pool);
      console.log('      E: ' + o.map(x => x.p.title + ' ' + x.s.toFixed(3)).join(' | '));
      console.log('      W: ' + w.order.slice(0, 5).map(p => p.title).join(' | ') + (w.arbitraryLead ? '   (lead arbitrary)' : ''));
    }
  }, 3_600_000);
});
