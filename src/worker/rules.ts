import { PRIORITY_RANK, type Priority } from "../shared/types";

export interface Rule {
  id: number;
  name: string;
  keywords: string[];
  priority: Priority;
  mentionRole: boolean;
  enabled: boolean;
  position: number;
}

export interface RuleMatch {
  rule: Rule;
  keyword: string;
}

export interface PriorityDecision {
  priority: Priority;
  source: "rule" | "ai" | "default";
  mentionRole: boolean;
  match: RuleMatch | null;
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const regexCache = new Map<string, RegExp>();

/** Whole-word/phrase matching: "down" matches "server is down!" but not "download". */
function keywordRegex(keyword: string): RegExp {
  let re = regexCache.get(keyword);
  if (!re) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "u");
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(keyword, re);
  }
  return re;
}

/**
 * Returns the matching enabled rule with the highest priority (ties → lowest position),
 * so the outcome never depends on how an admin happened to order the list.
 */
export function matchRules(text: string, rules: Rule[]): RuleMatch | null {
  const haystack = normalize(text);
  let best: RuleMatch | null = null;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const keyword = rule.keywords.map(normalize).find((k) => k.length > 0 && keywordRegex(k).test(haystack));
    if (keyword === undefined) continue;
    const better =
      !best ||
      PRIORITY_RANK[rule.priority] > PRIORITY_RANK[best.rule.priority] ||
      (PRIORITY_RANK[rule.priority] === PRIORITY_RANK[best.rule.priority] && rule.position < best.rule.position);
    if (better) best = { rule, keyword };
  }
  return best;
}

/**
 * Admin rules set the floor; AI may only escalate. A prompt-injected or mistaken model can
 * therefore never hide a report that the server's own rules consider urgent.
 */
export function decidePriority(match: RuleMatch | null, aiSeverity: Priority | null): PriorityDecision {
  let priority: Priority = match?.rule.priority ?? "normal";
  let source: PriorityDecision["source"] = match ? "rule" : "default";
  if (aiSeverity && PRIORITY_RANK[aiSeverity] > PRIORITY_RANK[priority]) {
    priority = aiSeverity;
    source = "ai";
  }
  const mentionRole = Boolean(match?.rule.mentionRole) || priority === "critical";
  return { priority, source, mentionRole, match };
}

export function maxPriority(a: Priority | null, b: Priority): Priority {
  return a && PRIORITY_RANK[a] >= PRIORITY_RANK[b] ? a : b;
}
