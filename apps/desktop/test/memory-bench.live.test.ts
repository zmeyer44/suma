/**
 * LIVE memory-tool benchmark — which models actually use the assistant's
 * long-term memory well?
 *
 * Opt-in and paid, per the live-test convention (vm-provisioning-live):
 *
 *   pnpm --filter @suma/desktop bench:memory        (SUMA_MEMORY_BENCH=1)
 *
 * Needs AI_GATEWAY_API_KEY (repo-root .env or the environment) — requests go
 * straight to the Vercel AI Gateway with the caller's own key, never through
 * a user's vended quota. Each model runs four scenarios, twice each, every
 * trial against a fresh store on a real SimAgent temp root:
 *
 *   save      unprompted: does it add_memory a lasting fact the user shared?
 *   recall    does it search_memory past the wake summaries and answer right?
 *   compress  does it pay the compression chain a save triggers?
 *   wake      does it apply the wake context (no tools needed) to its answer?
 *
 * Scores are deterministic (tool-call inspection + store state + keyword
 * checks), so runs are comparable across models and over time. Results print
 * as a table and land as markdown+json next to the terminal output.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { afterAll, describe, it } from "vitest";
import { SimAgent } from "../src/main/compute/sim-agent";
import { loadDotEnv } from "../src/main/env";
import {
  ENTRY_MAX_BYTES,
  parseBlock,
  RAW_MAX,
  utf8Length,
} from "../src/main/memory/memory-core";
import { MemoryService } from "../src/main/memory/memory-service";
import { MemoryStore } from "../src/main/memory/memory-store";
import { createMemoryTools } from "../src/main/memory/memory-tools";

const ENABLED = process.env["SUMA_MEMORY_BENCH"] === "1";
if (ENABLED) loadDotEnv(process.cwd());
const HAS_KEY =
  (process.env["AI_GATEWAY_API_KEY"] ?? process.env["VERCEL_AI_GATEWAY_API_KEY"] ?? "") !== "";

const MODELS = [
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4-5",
  "openai/gpt-5.1",
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
];

const TRIALS_PER_SCENARIO = 2;
const MAX_STEPS = 12;

const BASE_PROMPT =
  "You are the assistant in Suma, a desktop web browser. You live in a sidebar next to the page the user is browsing. Keep answers concise and lead with the outcome.";

/* ------------------------------ harness ---------------------------------- */

interface Trial {
  service: MemoryService;
  store: MemoryStore;
  cleanup: () => Promise<void>;
}

async function freshTrial(): Promise<Trial> {
  const root = await mkdtemp(path.join(os.tmpdir(), "suma-membench-"));
  const link = new SimAgent({ root: () => root });
  const store = new MemoryStore(() => link);
  const service = new MemoryService();
  service.bind(link);
  return {
    service,
    store,
    cleanup: async () => {
      link.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function truncateUtf8(text: string, maxBytes: number): string {
  let out = text;
  while (utf8Length(out) > maxBytes) out = out.slice(0, -1);
  return out;
}

/** Seed memories and pay every pending compression deterministically (halves
 *  joined and truncated — the same lossy fixture OptMem's own tests use), so
 *  a trial starts from a settled tree without an LLM in the loop. */
async function seed(store: MemoryStore, texts: string[], date = "2026-06-01"): Promise<void> {
  if (texts.length > 0) await store.append(texts, date);
  for (;;) {
    const nap = await store.nextNap(await store.logLen());
    if (nap === null) return;
    const { lo, hi } = parseBlock(nap.block);
    const size = hi - lo;
    const material =
      size <= RAW_MAX
        ? (await store.logSlice(lo, hi)).map((e) => e.text)
        : ((
            await Promise.all([
              store.summary(lo, lo + size / 2),
              store.summary(lo + size / 2, hi),
            ])
          ).filter((s): s is string => s !== null));
    await store.putSummary(lo, hi, truncateUtf8(material.join(" | "), ENTRY_MAX_BYTES));
  }
}

interface RunOutcome {
  text: string;
  toolCalls: Array<{ toolName: string; input: unknown }>;
  toolErrors: number;
  totalTokens: number;
}

async function runAssistant(model: string, system: string, user: string, tools: ToolSet): Promise<RunOutcome> {
  const messages: ModelMessage[] = [{ role: "user", content: user }];
  const result = await generateText({
    model,
    system,
    messages,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
  });
  const toolCalls: Array<{ toolName: string; input: unknown }> = [];
  let toolErrors = 0;
  for (const step of result.steps) {
    for (const call of step.toolCalls) {
      toolCalls.push({ toolName: call.toolName, input: call.input as unknown });
    }
    for (const part of step.content) {
      if (part.type === "tool-error") toolErrors += 1;
    }
  }
  return {
    text: result.text,
    toolCalls,
    toolErrors,
    totalTokens: result.totalUsage.totalTokens ?? 0,
  };
}

function called(outcome: RunOutcome, toolName: string): boolean {
  return outcome.toolCalls.some((c) => c.toolName === toolName);
}

/* ------------------------------ scenarios --------------------------------- */

interface ScenarioResult {
  /** 0..1 */
  score: number;
  note: string;
  toolErrors: number;
  totalTokens: number;
}

type Scenario = (model: string) => Promise<ScenarioResult>;

async function withTrial(fn: (trial: Trial) => Promise<ScenarioResult>): Promise<ScenarioResult> {
  const trial = await freshTrial();
  try {
    return await fn(trial);
  } finally {
    await trial.cleanup();
  }
}

async function systemFor(trial: Trial): Promise<string> {
  const context = await trial.service.wakeContext();
  return context === null ? BASE_PROMPT : `${BASE_PROMPT}\n\n${context}`;
}

/** SAVE — the user mentions a lasting fact in passing; nobody says
 *  "remember". The JARVIS bar: it gets saved, and saved faithfully. */
const saveScenario: Scenario = (model) =>
  withTrial(async (trial) => {
    const outcome = await runAssistant(
      model,
      await systemFor(trial),
      "Oh and for future reference — I'm allergic to shellfish, so keep that in mind whenever you suggest restaurants or recipes. Anyway, what's a good quick lunch idea?",
      createMemoryTools(trial.service),
    );
    const saved = called(outcome, "add_memory");
    const log = await trial.store.logSlice(0, await trial.store.logLen());
    const faithful = log.some((e) => /shellfish/i.test(e.text) && /allerg/i.test(e.text));
    return {
      score: (saved ? 0.4 : 0) + (faithful ? 0.6 : 0),
      note: saved ? (faithful ? "saved faithfully" : "add_memory called but fact not stored") : "never called add_memory",
      toolErrors: outcome.toolErrors,
      totalTokens: outcome.totalTokens,
    };
  });

/** RECALL — the answer lives 100+ memories back, behind lossy summaries; the
 *  model must search rather than guess. */
const recallScenario: Scenario = (model) =>
  withTrial(async (trial) => {
    const filler = (i: number): string =>
      `Watched a documentary (#${i}) about ${["volcanoes", "octopuses", "trains", "glaciers", "typography"][i % 5]} and rated it ${(i % 5) + 4}/10`;
    const texts = Array.from({ length: 130 }, (_, i) => filler(i));
    texts[23] = "Dinner at Cervejaria Ramiro in Lisbon — loved the Quinta do Crasto red, wants it again";
    texts[60] = "Prefers window seats on flights";
    texts[95] = "Sister Ana lives in Porto";
    await seed(trial.store, texts);
    const outcome = await runAssistant(
      model,
      await systemFor(trial),
      "What was that red wine I loved at the seafood place in Lisbon? I want to order a case of it.",
      createMemoryTools(trial.service),
    );
    const searched = called(outcome, "search_memory") || called(outcome, "expand_memory");
    const correct = /quinta do crasto/i.test(outcome.text);
    return {
      score: (searched ? 0.3 : 0) + (correct ? 0.7 : 0),
      note: correct ? "answered correctly" : searched ? "searched but wrong answer" : "no search, wrong answer",
      toolErrors: outcome.toolErrors,
      totalTokens: outcome.totalTokens,
    };
  });

/** COMPRESS — saving the 16th memory owes a 4-nap chain (14-15, 12-15, 8-15,
 *  0-15); each tool result hands the model the next. Does it pay all of it? */
const compressScenario: Scenario = (model) =>
  withTrial(async (trial) => {
    await seed(
      trial.store,
      Array.from({ length: 15 }, (_, i) => `Fact ${i}: enjoys ${["hiking", "jazz", "ramen", "chess", "sailing"][i % 5]} (note ${i})`),
    );
    const outcome = await runAssistant(
      model,
      await systemFor(trial),
      "My sister Ana just moved to Berlin — please remember that.",
      createMemoryTools(trial.service),
    );
    const saved = (await trial.store.scanMatches(/Ana/i, 6000)).total > 0;
    const owedBefore = 4;
    const owedAfter = await trial.store.pendingCompressions(await trial.store.logLen());
    const paid = saved ? Math.max(0, owedBefore - owedAfter) / owedBefore : 0;
    return {
      score: (saved ? 0.4 : 0) + 0.6 * paid,
      note: saved
        ? owedAfter === 0
          ? "saved and paid the whole chain"
          : `saved; ${owedAfter} of 4 compressions left unpaid`
        : "never saved the fact",
      toolErrors: outcome.toolErrors,
      totalTokens: outcome.totalTokens,
    };
  });

/** WAKE — no tools needed: the answer should simply respect what the wake
 *  context already says about the user. */
const wakeScenario: Scenario = (model) =>
  withTrial(async (trial) => {
    await seed(trial.store, [
      "Is vegetarian (since 2024) — no meat or fish, eggs and dairy fine",
      "Training for the Lisbon half marathon in October",
      "Cat named Möbius",
      "Prefers metric units",
      "Works as a product designer at a fintech startup",
    ]);
    const outcome = await runAssistant(
      model,
      await systemFor(trial),
      "Any ideas for a high-protein dinner tonight?",
      createMemoryTools(trial.service),
    );
    const meat = /\b(chicken|beef|pork|steak|salmon|tuna|shrimp|turkey|bacon|lamb|fish)\b/i.test(outcome.text);
    const veggie = /\b(tofu|tempeh|seitan|lentil\w*|bean\w*|chickpea\w*|paneer|halloumi|egg\w*|quinoa|greek yogurt|cottage cheese|edamame)\b/i.test(outcome.text);
    return {
      score: (meat ? 0 : 0.5) + (veggie ? 0.5 : 0),
      note: meat ? "suggested meat to a vegetarian" : veggie ? "respected the vegetarian memory" : "no meat, but no concrete protein either",
      toolErrors: outcome.toolErrors,
      totalTokens: outcome.totalTokens,
    };
  });

const SCENARIOS: Record<string, Scenario> = {
  save: saveScenario,
  recall: recallScenario,
  compress: compressScenario,
  wake: wakeScenario,
};

/* -------------------------------- runner ---------------------------------- */

interface ModelReport {
  model: string;
  scenarios: Record<string, { mean: number; notes: string[] }>;
  overall: number;
  toolErrors: number;
  totalTokens: number;
  failures: string[];
}

const reports: ModelReport[] = [];

describe.skipIf(!ENABLED || !HAS_KEY)("memory model benchmark (live)", () => {
  if (ENABLED && !HAS_KEY) {
    throw new Error("SUMA_MEMORY_BENCH=1 but AI_GATEWAY_API_KEY is not set");
  }

  for (const model of MODELS) {
    it(
      `benchmarks ${model}`,
      async () => {
        const report: ModelReport = {
          model,
          scenarios: {},
          overall: 0,
          toolErrors: 0,
          totalTokens: 0,
          failures: [],
        };
        // All trials for one model in parallel — each has its own store.
        const entries = Object.entries(SCENARIOS).flatMap(([name, scenario]) =>
          Array.from({ length: TRIALS_PER_SCENARIO }, (_, i) => ({ name, scenario, trial: i })),
        );
        const results = await Promise.all(
          entries.map(async ({ name, scenario, trial }) => {
            try {
              return { name, result: await scenario(model) };
            } catch (err) {
              report.failures.push(`${name}#${trial}: ${err instanceof Error ? err.message : String(err)}`);
              return {
                name,
                result: { score: 0, note: "trial errored", toolErrors: 0, totalTokens: 0 },
              };
            }
          }),
        );
        for (const name of Object.keys(SCENARIOS)) {
          const mine = results.filter((r) => r.name === name).map((r) => r.result);
          report.scenarios[name] = {
            mean: mine.reduce((a, r) => a + r.score, 0) / mine.length,
            notes: mine.map((r) => r.note),
          };
        }
        report.toolErrors = results.reduce((a, r) => a + r.result.toolErrors, 0);
        report.totalTokens = results.reduce((a, r) => a + r.result.totalTokens, 0);
        const means = Object.values(report.scenarios).map((s) => s.mean);
        report.overall = means.reduce((a, b) => a + b, 0) / means.length;
        reports.push(report);
        console.log(
          `${model}: overall ${(report.overall * 100).toFixed(0)}% — ` +
            Object.entries(report.scenarios)
              .map(([n, s]) => `${n} ${(s.mean * 100).toFixed(0)}%`)
              .join(", ") +
            (report.failures.length > 0 ? ` (${report.failures.length} errored trials)` : ""),
        );
      },
      600_000,
    );
  }

  afterAll(async () => {
    if (reports.length === 0) return;
    const sorted = [...reports].sort((a, b) => b.overall - a.overall);
    const names = Object.keys(SCENARIOS);
    const lines = [
      "# Memory tool benchmark",
      "",
      `${TRIALS_PER_SCENARIO} trials per scenario per model; deterministic scoring.`,
      "",
      `| model | overall | ${names.join(" | ")} | tool errors | tokens |`,
      `|---|---|${names.map(() => "---").join("|")}|---|---|`,
      ...sorted.map(
        (r) =>
          `| ${r.model} | ${(r.overall * 100).toFixed(0)}% | ` +
          names.map((n) => `${((r.scenarios[n]?.mean ?? 0) * 100).toFixed(0)}%`).join(" | ") +
          ` | ${r.toolErrors} | ${r.totalTokens} |`,
      ),
      "",
      ...sorted.flatMap((r) => [
        `## ${r.model}`,
        ...names.map((n) => `- ${n}: ${(r.scenarios[n]?.notes ?? []).join(" / ")}`),
        ...(r.failures.length > 0 ? [`- errors: ${r.failures.join("; ")}`] : []),
        "",
      ]),
    ];
    const out = process.env["SUMA_MEMORY_BENCH_OUT"] ?? path.join(os.tmpdir(), "suma-memory-bench");
    await writeFile(`${out}.md`, lines.join("\n"));
    await writeFile(`${out}.json`, JSON.stringify(sorted, null, 2));
    console.log(`\n${lines.slice(4).join("\n")}\nWritten to ${out}.md / ${out}.json`);
  });
});

describe.skipIf(ENABLED)("memory benchmark gate", () => {
  it("is opt-in", () => {
    // Present so `vitest run` on this file without the env var reports a
    // skipped suite instead of "no tests".
  });
});
