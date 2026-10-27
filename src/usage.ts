// Token usage of a driver run and the per-folder token budget (plan driver-chat-resolver d3;
// operator Ask driver-token-usage-field = "Add usage to run_end and tick_end (protocol
// 1.3.0)"). The numbers are the kit's `tick_end.usage` / `run_end.usage` (kit
// docs/driver-events-protocol.md "Token usage"), read only when the run's
// `run_start.protocol` is 1.3.0 or newer. An older engine shows "no usage": Colony never
// derives tokens from the agent's own stream (`agent_event`). The budget is informational:
// passing it shows the run as over budget and nothing else (no stop, no answer).
// No I/O here: Node runs it with its types stripped (scripts/usage.test.mjs).

export interface TokenUsage {
  /** Every input token the models read, cached included. */
  inputTokens: number;
  /** Part of `inputTokens` read from a prompt cache, or null when the backend does not split it. */
  cachedInputTokens: number | null;
  outputTokens: number;
  /** `inputTokens + outputTokens`. */
  totalTokens: number;
}

/** The first driver protocol whose `tick_end` / `run_end` carry `usage`. */
export const USAGE_PROTOCOL = "1.3.0";

/** Whether a run that announced `protocol` in `run_start` reports token usage (1.x, >= 1.3.0, no pre-release). */
export function protocolHasUsage(protocol: unknown): boolean {
  if (typeof protocol !== "string") return false;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(protocol.trim());
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major === 1 && minor >= 3;
}

const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The kit's `usage` object, or null when it is absent or not that shape. */
export function readUsage(v: unknown): TokenUsage | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const { inputTokens, outputTokens, totalTokens } = o;
  if (!count(inputTokens) || !count(outputTokens) || !count(totalTokens)) return null;
  if (totalTokens !== inputTokens + outputTokens) return null;
  const cached = o.cachedInputTokens ?? null;
  if (cached !== null && (!count(cached) || cached > inputTokens)) return null;
  return { inputTokens, cachedInputTokens: cached, outputTokens, totalTokens };
}

/** Sum of two usages; null only when both are. */
export function addUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a) return b;
  if (!b) return a;
  const cached = a.cachedInputTokens === null && b.cachedInputTokens === null ? null : (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0);
  const input = a.inputTokens + b.inputTokens;
  const output = a.outputTokens + b.outputTokens;
  return { inputTokens: input, cachedInputTokens: cached, outputTokens: output, totalTokens: input + output };
}

/** `590.4k`, `12.3M`, `999`. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** One line for a run's tokens: `supported` is the run's protocol check. */
export function usageText(supported: boolean, usage: TokenUsage | null): string {
  if (!supported) return `no usage (engine protocol below ${USAGE_PROTOCOL})`;
  if (!usage) return "no usage reported";
  const parts = [`${formatTokens(usage.inputTokens)} in`];
  if (usage.cachedInputTokens !== null) parts.push(`${formatTokens(usage.cachedInputTokens)} cached`);
  parts.push(`${formatTokens(usage.outputTokens)} out`);
  return `${formatTokens(usage.totalTokens)} tokens (${parts.join(", ")})`;
}

/**
 * The per-run token budget a folder setting holds: null for none (empty), a positive integer
 * (`_`, `,` and spaces allowed as separators), else "invalid".
 */
export function parseBudget(v: unknown): number | null | "invalid" {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isInteger(v) && v > 0 ? v : "invalid";
  if (typeof v !== "string") return "invalid";
  const t = v.trim().replace(/[_,\s]/g, "");
  if (!t) return null;
  if (!/^\d+$/.test(t)) return "invalid";
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : "invalid";
}

/** Where a run stands against the folder's budget. Informational only. */
export function budgetState(usage: TokenUsage | null, budget: number | null): "none" | "within" | "over" {
  if (!usage || budget === null) return "none";
  return usage.totalTokens > budget ? "over" : "within";
}
