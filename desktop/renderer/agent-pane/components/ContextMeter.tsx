import { useStore } from "../store";

// Hard-coded model context windows. The 1M-context Opus 4.7 variant is
// disambiguated by the "[1m]" suffix on the model id (see CLAUDE_CODE
// fast-mode docs).
const MODEL_LIMITS: Record<string, number> = {
  "claude-opus-4-7": 200_000,
  "claude-opus-4-7[1m]": 1_000_000,
  "claude-sonnet-4-6": 200_000,
  "claude-haiku-4-5": 200_000,
};
const DEFAULT_LIMIT = 200_000;

export function limitFor(model: string | undefined): number {
  if (!model) return DEFAULT_LIMIT;
  if (MODEL_LIMITS[model] != null) return MODEL_LIMITS[model];
  // Strip a trailing date suffix like "claude-haiku-4-5-20251001" before
  // checking again.
  const stripped = model.replace(/-\d{8}$/, "");
  if (MODEL_LIMITS[stripped] != null) return MODEL_LIMITS[stripped];
  return DEFAULT_LIMIT;
}

// `usage` is typed as `unknown` on TurnDone (matches SDK opacity). Sum the
// input-side counters so the meter reflects what the model actually saw
// this turn — once caching kicks in, raw input_tokens alone drops near
// zero and would misrepresent context-window pressure.
export function readInputTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
  const cc =
    typeof u.cache_creation_input_tokens === "number"
      ? u.cache_creation_input_tokens
      : 0;
  const cr =
    typeof u.cache_read_input_tokens === "number"
      ? u.cache_read_input_tokens
      : 0;
  const total = input + cc + cr;
  return total > 0 ? total : null;
}

export function levelFor(ratio: number): "ok" | "warn" | "danger" {
  return ratio < 0.6 ? "ok" : ratio < 0.85 ? "warn" : "danger";
}

export function ContextMeter() {
  const lastTurn = useStore((s) => s.lastTurn);
  const model = useStore((s) => s.session?.model);

  const tokens = readInputTokens(lastTurn?.usage);
  if (tokens == null) return null;

  const limit = limitFor(model);
  const ratio = Math.min(tokens / limit, 1);
  const pct = Math.round(ratio * 100);
  const level = levelFor(ratio);
  const tooltip = `${tokens.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct}% used)`;

  return (
    <div
      className="context-meter"
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="context window usage"
      title={tooltip}
    >
      <div
        className={`context-meter__fill context-meter__fill--${level}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
