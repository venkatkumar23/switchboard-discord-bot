// Pure data (no Worker types) so scripts/create-admin.ts can share it.
import type { Priority } from "../shared/types";

/** The starting rule set every newly seen server gets. */
export const DEFAULT_RULES: { name: string; keywords: string[]; priority: Priority; mentionRole: boolean }[] = [
  {
    name: "Security incident",
    keywords: ["hacked", "hack", "phishing", "scam", "compromised", "token leak", "raid", "malware", "doxxed"],
    priority: "critical",
    mentionRole: true,
  },
  {
    name: "Outage",
    keywords: ["down", "outage", "not working", "broken", "crash", "crashed", "500", "can't log in", "cannot log in"],
    priority: "high",
    mentionRole: true,
  },
  {
    name: "Minor",
    keywords: ["typo", "cosmetic", "suggestion", "feature request", "nitpick"],
    priority: "low",
    mentionRole: false,
  },
];
