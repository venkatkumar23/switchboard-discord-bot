// Structured JSON logging with secret redaction. Workers Logs indexes the JSON fields,
// so every line is one object: { level, event, ...fields }.

type Level = "debug" | "info" | "warn" | "error";

const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|api[-_]?key|webhook|signature|private/i;

const SECRET_PATTERNS: [RegExp, string][] = [
  // Discord webhook / interaction-token URLs (the path segment after the id is a credential)
  [/(discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/)[\w.-]+/gi, "$1[redacted]"],
  [/https:\/\/hooks\.slack\.com\/[^\s"'<>]+/gi, "https://hooks.slack.com/[redacted]"],
  // Discord bot tokens: three base64url segments
  [/\b[\w-]{23,28}\.[\w-]{6,7}\.[\w-]{27,40}\b/g, "[redacted-bot-token]"],
  [/\bBot\s+[\w.-]{20,}/g, "Bot [redacted]"],
  [/\bBearer\s+[\w.-]{8,}/g, "Bearer [redacted]"],
  [/\bgsk_[A-Za-z0-9]{16,}\b/g, "[redacted-api-key]"],
  [/\bAIza[\w-]{30,}\b/g, "[redacted-api-key]"],
];

export function redactString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Deep-copies `value`, masking secret-looking keys and secret-looking string contents. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) && v != null && v !== "" ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function emit(level: Level, event: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ level, event, ...(fields ? (redact(fields) as object) : {}) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
