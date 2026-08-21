// Ambiguity probe — does an annotated name change the dedup decision?
//
// The read half of the domain axis (Tag-Achse — Design-Entwurf, "Die
// Lesehälfte") claims that a name travelling with its domain disambiguates
// better than a bare name at the places where the model decides identity.
// Before two prompts are touched, this asks whether that is true on the one
// place that costs the most: `resolveEntityDedup`, the candidate list a new
// item is compared against.
//
// Two arms, same cases, same model, interleaved draws:
//   A  the plugin's prompt as it stands (bare `path / title / aliases` lines)
//   B  the same prompt with one `domains:` line per candidate and one
//      `- Domains:` line on the new item, plus one sentence on how to read them
//
// Everything else is the plugin's own code over the vault: ConflictResolver
// (so cases the resolver decides without a call are reported as such, not
// pushed through the model), selectDedupCandidates (the real top-K window),
// PROMPTS.resolveEntityDedup, the system prompt via SchemaManager. Only the
// annotation varies.
//
// The annotation is SYNTHESIZED: before the rebuild no wiki page carries
// `domains:`, so a page's domains here are the union of the tags of the notes
// behind its `sources:` (page → sources/<slug> → source_file → note → tags).
// That is what stage 2 would have written for the source page; an entity page
// would carry a subset (stage 3). Read the results with that in mind: the
// candidate annotation is the upper bound of what the writer delivers.
//
// Read-only against the vault; writes one JSONL line per draw to LLM_WIKI_OUT.
//
// Copy into <plugin>/src/ and run:
//   LLM_WIKI_VAULT=~/MyVault LLM_WIKI_DRY=1 npx vitest run src/ambiguity-probe.test.ts --reporter=verbose --silent=false
//   LLM_WIKI_VAULT=~/MyVault LLM_WIKI_DRAWS=3 npx vitest run src/ambiguity-probe.test.ts --reporter=verbose --silent=false
//
// | variable              | default                                  |
// |---|---|
// | LLM_WIKI_VAULT        | required                                 |
// | LLM_WIKI_FOLDER       | wiki                                     |
// | LLM_WIKI_CASES        | <vault>/wiki/schema/ambiguity-cases.json |
// | LLM_WIKI_DRAWS        | 3                                        |
// | LLM_WIKI_DRY          | unset; 1 = render prompts, no model call |
// | LLM_WIKI_ONLY         | unset; comma list of case ids            |
// | LLM_WIKI_BASE_URL     | plugin data.json baseUrl, else localhost:1234/v1 |
// | LLM_WIKI_MODEL        | plugin data.json model                   |
// | LLM_WIKI_TEMPERATURE  | 0.15                                     |
// | LLM_WIKI_OUT          | ./ambiguity-draws.jsonl                  |

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync, writeFileSync } from 'fs';
import { join } from 'path';
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
import { TOKENS_DEDUP_RESOLUTION } from './constants';
import { sourceBaseSlug } from './core/source-slug';

const VAULT = process.env.LLM_WIKI_VAULT!;
const WIKI = process.env.LLM_WIKI_FOLDER ?? 'wiki';
const CASES = process.env.LLM_WIKI_CASES ?? join(VAULT, WIKI, 'schema', 'ambiguity-cases.json');
const DRAWS = Number(process.env.LLM_WIKI_DRAWS ?? 3);
const DRY = process.env.LLM_WIKI_DRY === '1';
const ONLY = process.env.LLM_WIKI_ONLY ? new Set(process.env.LLM_WIKI_ONLY.split(',').map(s => s.trim())) : null;
const OUT = process.env.LLM_WIKI_OUT ?? './ambiguity-draws.jsonl';
const TEMPERATURE = Number(process.env.LLM_WIKI_TEMPERATURE ?? 0.15);
/** 1 = append the expected page to the window when the top-K left it out — measures the annotation apart from the window. */
const ORACLE = process.env.LLM_WIKI_ORACLE_WINDOW === '1';
const NOTE_FOLDERS = (process.env.LLM_WIKI_NOTE_FOLDERS ?? 'Notizen,Frontier-Notizen').split(',').map(s => s.trim()).filter(Boolean);

type PageType = 'entity' | 'concept';
interface Page { path: string; title: string; aliases: string[]; tags: string[]; sources: string[]; ctime: number; domains: string[] }
interface Case {
  id: string; class: string;
  item: { name: string; pageType: PageType; type: string; summary: string; domains: string[] };
  expected: { match: boolean; title?: string };
  expected_note?: string;
  strip_alias?: string;
}

function loadSettings(): LLMWikiSettings {
  const p = join(VAULT, '.obsidian', 'plugins', 'karpathywiki', 'data.json');
  const data = existsSync(p) ? JSON.parse(readFileSync(p, 'utf-8')) as Partial<LLMWikiSettings> : {};
  return { ...DEFAULT_SETTINGS, ...data };
}

// source slug → note: `source_file:` on the source page where present (106 of
// 422 here), else the plugin's own slug of the note basename (sourceBaseSlug,
// the local plain-basename patch) — built once over the note folders.
let noteBySlug: Map<string, string> | null = null;
function noteMap(preserve: boolean): Map<string, string> {
  if (noteBySlug) return noteBySlug;
  noteBySlug = new Map();
  for (const folder of NOTE_FOLDERS) {
    const dir = join(VAULT, folder);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const rel = `${folder}/${f}`;
      noteBySlug.set(sourceBaseSlug(rel, preserve), rel);
    }
  }
  return noteBySlug;
}

const noteTagCache = new Map<string, string[]>();
function noteTagsForSource(sourceSlug: string, preserve: boolean): string[] {
  if (noteTagCache.has(sourceSlug)) return noteTagCache.get(sourceSlug)!;
  let tags: string[] = [];
  let ref = '';
  const sp = join(VAULT, WIKI, 'sources', `${sourceSlug}.md`);
  if (existsSync(sp)) {
    const sfm = parseFrontmatter(readFileSync(sp, 'utf-8'));
    if (typeof sfm?.source_file === 'string') ref = sfm.source_file.replace(/^\[\[|\]\]$/g, '');
  }
  if (!ref) ref = noteMap(preserve).get(sourceSlug) ?? '';
  const np = ref ? join(VAULT, ref) : '';
  if (np && existsSync(np)) {
    const nfm = parseFrontmatter(readFileSync(np, 'utf-8'));
    if (Array.isArray(nfm?.tags)) tags = nfm.tags.map(String).map(t => t.trim()).filter(Boolean);
  }
  noteTagCache.set(sourceSlug, tags);
  return tags;
}

function loadPages(folder: 'entities' | 'concepts', preserve: boolean): Page[] {
  const dir = join(VAULT, WIKI, folder);
  return readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
    const full = join(dir, f);
    const fm = parseFrontmatter(readFileSync(full, 'utf-8')) ?? {};
    const sources = Array.isArray(fm.sources) ? fm.sources.map(String) : [];
    const domains: string[] = [];
    for (const s of sources) {
      const m = /sources\/([^\]|]+)/.exec(s);
      if (!m) continue;
      for (const t of noteTagsForSource(m[1].trim(), preserve)) if (!domains.includes(t)) domains.push(t);
    }
    return {
      path: `${WIKI}/${folder}/${f}`,
      title: f.replace(/\.md$/, ''),
      aliases: Array.isArray(fm.aliases) ? fm.aliases.map(String) : [],
      tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
      sources,
      ctime: statSync(full).birthtimeMs,
      domains,
    };
  });
}

/** Arm B template: the plugin's prompt plus the annotation, derived — not retyped. */
function armBTemplate(): string {
  const T = PROMPTS.resolveEntityDedup;
  const a1 = '- Type: {{entity_type}}\n';
  const a2 = '- Spelling variations\n';
  if (!T.includes(a1) || !T.includes(a2)) throw new Error('resolveEntityDedup prompt changed — anchors for arm B not found');
  return T
    .replace(a1, a1 + '- Domains: {{entity_domains}}\n')
    .replace(a2, a2 + "- Domains (where given) are the note authors' classification of what a page is about. Use them to weigh candidates — two pages with the same name but different domains are usually different things — but a differing domain alone never rules out a match, and a candidate without domains is judged as before\n");
}

const JSON_SCHEMA = {
  name: 'path_resolution',
  schema: {
    type: 'object',
    properties: { match: { type: 'boolean' }, path: { type: ['string', 'null'] } },
    additionalProperties: true,
  },
};

async function callModel(baseUrl: string, model: string, system: string | undefined, user: string) {
  const t0 = Date.now();
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }],
      temperature: TEMPERATURE,
      max_tokens: TOKENS_DEDUP_RESOLUTION,
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

function basenameOf(p: string): string {
  return p.replace(/^\[\[|\]\]$/g, '').split('/').pop()!.replace(/\.md$/i, '');
}

describe('ambiguity probe — annotated names at resolveEntityDedup', () => {
  it('two arms, interleaved draws', async () => {
    expect(VAULT, 'set LLM_WIKI_VAULT').toBeTruthy();
    const settings = loadSettings();
    const baseUrl = process.env.LLM_WIKI_BASE_URL ?? (settings as unknown as { baseUrl?: string }).baseUrl ?? 'http://localhost:1234/v1';
    const model = process.env.LLM_WIKI_MODEL ?? settings.model;
    const preserve = settings.slugCase === 'preserve';
    const cases = (JSON.parse(readFileSync(CASES, 'utf-8')) as { cases: Case[] }).cases
      .filter(c => !ONLY || ONLY.has(c.id));
    const entities = loadPages('entities', preserve);
    const concepts = loadPages('concepts', preserve);
    const allPagesRaw = [...entities, ...concepts];

    // System prompt exactly as the plugin builds it for the dedup call ('index' selector).
    const fakeApp = {
      vault: {
        getAbstractFileByPath: (p: string) => existsSync(join(VAULT, p)) ? Object.assign(new TFile(), { path: p }) : null,
        read: async (f: { path: string }) => readFileSync(join(VAULT, f.path), 'utf-8'),
      },
    };
    const sm = new SchemaManager(fakeApp as never, settings, () => null);
    const system = await buildSystemPrompt(settings, (task) => sm.getSchemaContext(task as never), 'index');
    const TB = armBTemplate();

    const header = {
      probe: 'ambiguity-probe', at: new Date().toISOString(), vault: VAULT, model, baseUrl, temperature: TEMPERATURE,
      draws: DRAWS, dry: DRY, oracleWindow: ORACLE, cases: cases.length, pages: { entities: entities.length, concepts: concepts.length },
      pagesWithSynthesizedDomains: allPagesRaw.filter(p => p.domains.length > 0).length,
      systemPromptChars: system?.length ?? 0,
    };
    console.log(JSON.stringify(header));
    if (!DRY) writeFileSync(OUT, JSON.stringify({ header }) + '\n');

    type Prepared = { c: Case; deterministic?: string; promptA?: string; promptB?: string; listSize?: number; expectedPath?: string; targetAnnotated?: boolean; ambiguousHead?: number; oracle?: boolean };
    const prepared: Prepared[] = [];

    for (const c of cases) {
      const folder = c.item.pageType === 'entity' ? 'entities' : 'concepts';
      // Strip a curated alias so the case reaches the model (a known name is resolved without a call).
      const allPages = c.strip_alias
        ? allPagesRaw.map(p => ({ ...p, aliases: p.aliases.filter(a => a.toLowerCase() !== c.strip_alias!.toLowerCase()) }))
        : allPagesRaw;
      const expectedPath = c.expected.title
        ? allPages.find(p => p.path.startsWith(`${WIKI}/${folder}/`) && p.title === c.expected.title)?.path
        : undefined;
      if (c.expected.title && !expectedPath) {
        prepared.push({ c, deterministic: `CASE ERROR: expected page "${c.expected.title}" not found in ${folder}/` });
        continue;
      }
      const slug = slugify(c.item.name, preserve);
      if (existsSync(join(VAULT, WIKI, folder, `${slug}.md`))) {
        prepared.push({ c, deterministic: `exact slug match → ${WIKI}/${folder}/${slug}.md`, expectedPath });
        continue;
      }
      const cr = new ConflictResolver(WIKI, allPages).resolve({ name: c.item.name, slug, pageType: c.item.pageType, tags: [c.item.type] });
      if (cr.action === 'merge') {
        prepared.push({ c, deterministic: `ConflictResolver: ${cr.reason} → ${cr.targetPath}`, expectedPath });
        continue;
      }
      const ambiguous = cr.action === 'disambiguate' ? (cr.candidates ?? []) : [];
      const sameType = allPages
        .filter(p => p.path.includes(`/${folder}/`))
        .filter(p => !/^(entities|concepts|sources)([^\s\-_a-zA-Z0-9])/.test(p.title || ''))
        .sort((a, b) => (a.ctime ?? 0) - (b.ctime ?? 0));
      const selected = selectDedupCandidates(c.item.name, c.item.summary, sameType);
      const byPath = new Map(allPages.map(p => [p.path, p]));
      const list = (ambiguous.length > 0
        ? [...ambiguous, ...selected.filter(p => !ambiguous.some(a => a.path === p.path))]
        : selected).map(p => byPath.get(p.path) ?? { ...p, domains: [] as string[], aliases: p.aliases ?? [] });
      let oracle = false;
      if (ORACLE && expectedPath && !list.some(p => p.path === expectedPath)) {
        list.push(byPath.get(expectedPath)!); // at the end, where a newest page would sit
        oracle = true;
      }
      const lineA = (p: { path: string; title: string; aliases?: string[] }) =>
        `- path: ${p.path}\n  title: ${p.title}${p.aliases?.length ? `\n  aliases: ${p.aliases.join(', ')}` : ''}`;
      const lineB = (p: { path: string; title: string; aliases?: string[]; domains?: string[] }) =>
        lineA(p) + (p.domains?.length ? `\n  domains: ${p.domains.join(', ')}` : '');
      const vars = {
        wikiFolder: settings.wikiFolder, entity_name: c.item.name, entity_type: c.item.pageType,
        entity_summary: c.item.summary.substring(0, 300), page_type: c.item.pageType,
      };
      const promptA = renderTemplate(PROMPTS.resolveEntityDedup, { ...vars, existing_pages: list.map(lineA).join('\n') });
      const promptB = renderTemplate(TB, { ...vars, existing_pages: list.map(lineB).join('\n'), entity_domains: c.item.domains.length ? c.item.domains.join(', ') : 'none' });
      const target = expectedPath ? byPath.get(expectedPath) : undefined;
      prepared.push({
        c, promptA, promptB, listSize: list.length, expectedPath, ambiguousHead: ambiguous.length, oracle,
        targetAnnotated: target ? target.domains.length > 0 : undefined,
      });
      if (expectedPath && !list.some(p => p.path === expectedPath)) {
        prepared[prepared.length - 1].deterministic = `expected page is NOT in the candidate window (${list.length}) — the model cannot find it in either arm`;
      }
    }

    // Report the preparation: which cases reach the model, and how.
    for (const p of prepared) {
      if (p.deterministic && !p.promptA) console.log(`${p.c.id} [${p.c.class}] ${p.c.item.name} — no model call: ${p.deterministic}`);
      else console.log(`${p.c.id} [${p.c.class}] ${p.c.item.name} — window ${p.listSize} (prompt A ${Math.round(p.promptA!.length / 1000)}k / B ${Math.round(p.promptB!.length / 1000)}k chars)${p.oracle ? ' (oracle: target appended)' : ''}${p.ambiguousHead ? ` (designator-ambiguous head ${p.ambiguousHead})` : ''}, expected ${p.c.expected.match ? p.expectedPath : 'no match'}${p.targetAnnotated === false ? ' ⚠ target has no synthesized domains' : ''}${p.deterministic ? ` ⚠ ${p.deterministic}` : ''}`);
    }
    if (DRY) {
      const sample = prepared.find(p => p.promptB && p.c.id === 'P3') ?? prepared.find(p => p.promptB);
      if (sample) {
        console.log('\n===== SYSTEM PROMPT (index selector) =====\n' + (system ?? '(none)'));
        console.log(`\n===== ARM B PROMPT, ${sample.c.id} =====\n` + sample.promptB);
      }
      return;
    }

    const runnable = prepared.filter(p => p.promptA && p.promptB);
    const tally = new Map<string, { A: string[]; B: string[] }>();
    for (const p of runnable) tally.set(p.c.id, { A: [], B: [] });

    const verdictOf = (p: Prepared, parsed: { match?: unknown; path?: unknown } | null): string => {
      if (!parsed) return 'unreadable';
      const matched = parsed.match === true && typeof parsed.path === 'string' && parsed.path.trim();
      if (!matched) return p.c.expected.match ? 'missed' : 'correct-nomatch';
      const bn = basenameOf(String(parsed.path));
      if (p.c.expected.match) return bn === basenameOf(p.expectedPath!) ? 'correct-match' : `wrong-page:${bn}`;
      return `false-match:${bn}`;
    };

    // Interleaved by draw, blocked by arm within a draw: the full-list cases
    // share a byte-identical prefix inside one arm (that is the plugin's own
    // cache design), and the arm order alternates per draw so session drift
    // does not land on one arm.
    for (let draw = 1; draw <= DRAWS; draw++) {
      const order: Array<'A' | 'B'> = draw % 2 === 1 ? ['A', 'B'] : ['B', 'A'];
      for (const arm of order) {
        for (const p of runnable) {
          const prompt = arm === 'A' ? p.promptA! : p.promptB!;
          const r = await callModel(baseUrl, model, system, prompt);
          const verdict = verdictOf(p, r.parsed);
          tally.get(p.c.id)![arm].push(verdict);
          const line = {
            draw, case: p.c.id, class: p.c.class, arm, name: p.c.item.name, verdict, oracle: p.oracle ?? false,
            match: r.parsed?.match ?? null, path: r.parsed?.path ?? null, ms: r.ms,
            prompt_tokens: (r.usage as { prompt_tokens?: number } | undefined)?.prompt_tokens ?? null,
            completion_tokens: (r.usage as { completion_tokens?: number } | undefined)?.completion_tokens ?? null,
            raw: r.parsed ? undefined : r.content.slice(0, 200), error: r.error,
          };
          appendFileSync(OUT, JSON.stringify(line) + '\n');
          console.log(`d${draw} ${p.c.id} ${arm} ${verdict} (${r.ms} ms${line.prompt_tokens ? `, ${line.prompt_tokens} in` : ''})`);
        }
      }
    }

    // Summary: accuracy per arm, per class; per case the two distributions; flips.
    const isCorrect = (v: string) => v.startsWith('correct');
    const summary: Record<string, unknown> = {};
    for (const arm of ['A', 'B'] as const) {
      const all = runnable.flatMap(p => tally.get(p.c.id)![arm]);
      const byClass: Record<string, string> = {};
      for (const cls of [...new Set(runnable.map(p => p.c.class))]) {
        const vs = runnable.filter(p => p.c.class === cls).flatMap(p => tally.get(p.c.id)![arm]);
        byClass[cls] = `${vs.filter(isCorrect).length}/${vs.length}`;
      }
      summary[arm] = { correct: `${all.filter(isCorrect).length}/${all.length}`, byClass };
    }
    const perCase = runnable.map(p => {
      const t = tally.get(p.c.id)!;
      const dist = (vs: string[]) => Object.entries(vs.reduce<Record<string, number>>((m, v) => ((m[v] = (m[v] ?? 0) + 1), m), {})).map(([k, n]) => `${k}×${n}`).join(' ');
      const a = t.A.filter(isCorrect).length, b = t.B.filter(isCorrect).length;
      return { id: p.c.id, class: p.c.class, name: p.c.item.name, A: dist(t.A), B: dist(t.B), delta: b - a, targetAnnotated: p.targetAnnotated, oracle: p.oracle ?? false };
    });
    console.log('\n===== SUMMARY =====');
    console.log(JSON.stringify(summary, null, 1));
    for (const r of perCase) console.log(`${r.id} ${r.class.padEnd(9)} ${r.name.padEnd(32)} A: ${r.A.padEnd(28)} B: ${r.B.padEnd(28)} Δ ${r.delta >= 0 ? '+' : ''}${r.delta}${r.targetAnnotated === false ? '  (target unannotated)' : ''}${r.oracle ? '  (oracle window)' : ''}`);
    const skipped = prepared.filter(p => !p.promptA);
    if (skipped.length) {
      console.log('\nnot put to the model:');
      for (const p of skipped) console.log(`  ${p.c.id} ${p.c.item.name}: ${p.deterministic}`);
    }
    appendFileSync(OUT, JSON.stringify({ summary, perCase, skipped: skipped.map(p => ({ id: p.c.id, why: p.deterministic })) }) + '\n');
    console.log(`\n→ ${OUT}`);
  }, 6 * 60 * 60 * 1000);
});
