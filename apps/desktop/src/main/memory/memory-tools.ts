/**
 * The assistant's memory tools — the AI SDK ToolSet over MemoryService.
 *
 * Four tools, one permission group ("memory" in CHAT_TOOL_GROUPS): the model
 * saves one-line memories, searches the whole log, opens summarized blocks,
 * and pays the compressions the store schedules. Failures are thrown Errors
 * so the SDK turns them into error tool results the model can recover from
 * (same contract as the browser tools) — a too-long memory comes back as
 * "too long: N bytes…" and the model shortens it.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import { ENTRY_MAX_BYTES } from "./memory-core";
import type { MemoryService } from "./memory-service";

/** What add_memory/compress_memory hand back when a compression is owed —
 *  shaped as an explicit ask so the model treats it as work, not metadata. */
function pendingField(pending: { instruction: string } | null): {
  compressionNeeded?: string;
} {
  return pending === null ? {} : { compressionNeeded: pending.instruction };
}

export function createMemoryTools(memory: MemoryService): ToolSet {
  return {
    add_memory: tool({
      description:
        `Save one lasting fact about the user to your permanent cross-conversation memory: a preference, a person, a date, a decision, a correction, a detail of their life or work. One line, at most ${ENTRY_MAX_BYTES} bytes. ` +
        "Do not save transient tasks, page content, secrets, or anything your memory context already holds. " +
        "If the result includes compressionNeeded, follow it with compress_memory once the user's request is done.",
      inputSchema: jsonSchema<{ text: string }>({
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "The memory: one self-contained line, telegram style — who/what, specifics, why it matters.",
          },
        },
        required: ["text"],
        additionalProperties: false,
      }),
      execute: async ({ text }) => {
        const result = await memory.note(text);
        return {
          saved: `#${result.id} ${result.line}`,
          ...pendingField(result.pending),
        };
      },
    }),

    search_memory: tool({
      description:
        "Search your permanent memory of the user. The query is a case-insensitive regular expression (plain words work) matched against full memory lines of the form \"#id YYYY-MM-DD text\" — so ids and dates match too. Use it when the answer may live in a summarized (#lo-hi) part of your memory context, or before saving something that might already be known.",
      inputSchema: jsonSchema<{ query: string }>({
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Regex or plain words, e.g. \"birthday\" or \"allerg\".",
          },
        },
        required: ["query"],
        additionalProperties: false,
      }),
      execute: async ({ query }) => {
        const result = await memory.recall(query);
        if (result.total === 0) return { matches: [], note: "No match." };
        return {
          matches: result.lines,
          ...(result.capped
            ? {
                note: `Newest ${result.lines.length} of ${result.total} matches — narrow the query for older ones.`,
              }
            : {}),
        };
      },
    }),

    expand_memory: tool({
      description:
        "Open a summarized block from your memory context (a \"#lo-hi\" line) one level: its two half-summaries, or the raw memories once the block is small. Use it to recover detail behind a summary; repeat on a half to descend further.",
      inputSchema: jsonSchema<{ block: string }>({
        type: "object",
        properties: {
          block: {
            type: "string",
            description: "The block id as shown, e.g. \"16-31\".",
          },
        },
        required: ["block"],
        additionalProperties: false,
      }),
      execute: async ({ block }) => ({ entries: await memory.expand(block) }),
    }),

    compress_memory: tool({
      description:
        `Pay a compression your memory asked for (via compressionNeeded or the pending note in your memory context): distill the named block into ONE line of at most ${ENTRY_MAX_BYTES} bytes. Keep what has lasting effect, drop what does not, invent nothing. Blocks settle strictly in order — compress exactly the block you were asked for.`,
      inputSchema: jsonSchema<{ block: string; summary: string }>({
        type: "object",
        properties: {
          block: {
            type: "string",
            description: "The block id you were asked to compress, e.g. \"16-31\".",
          },
          summary: {
            type: "string",
            description: "Your one-line distillation of that block.",
          },
        },
        required: ["block", "summary"],
        additionalProperties: false,
      }),
      execute: async ({ block, summary }) => {
        const result = await memory.compress(block, summary);
        return { result: result.message, ...pendingField(result.next) };
      },
    }),
  };
}
