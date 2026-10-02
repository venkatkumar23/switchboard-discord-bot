import { describe, expect, it } from "vitest";
import { decidePriority, matchRules, maxPriority, type Rule } from "../../src/worker/rules";

const rule = (over: Partial<Rule>): Rule => ({
  id: 1,
  name: "r",
  keywords: [],
  priority: "normal",
  mentionRole: false,
  enabled: true,
  position: 0,
  ...over,
});

const rules: Rule[] = [
  rule({ id: 1, name: "Minor", keywords: ["typo"], priority: "low", position: 0 }),
  rule({ id: 2, name: "Outage", keywords: ["down", "not working"], priority: "high", mentionRole: true, position: 1 }),
  rule({ id: 3, name: "Security", keywords: ["hacked"], priority: "critical", position: 2 }),
  rule({ id: 4, name: "Off", keywords: ["bot"], priority: "critical", enabled: false, position: 3 }),
];

describe("matchRules", () => {
  it("matches whole words only", () => {
    expect(matchRules("the server is DOWN!", rules)?.rule.name).toBe("Outage");
    expect(matchRules("download link is broken", rules)).toBeNull();
  });

  it("matches phrases across irregular whitespace and case", () => {
    expect(matchRules("Login is   Not\nWorking", rules)?.keyword).toBe("not working");
  });

  it("prefers the highest priority, regardless of list order", () => {
    expect(matchRules("typo on the page and my account got hacked", rules)?.rule.name).toBe("Security");
  });

  it("breaks priority ties by position", () => {
    const tied = [rule({ id: 9, name: "Second", keywords: ["x"], priority: "high", position: 5 }), rule({ id: 8, name: "First", keywords: ["x"], priority: "high", position: 1 })];
    expect(matchRules("x", tied)?.rule.name).toBe("First");
  });

  it("ignores disabled rules", () => {
    expect(matchRules("the bot", rules)).toBeNull();
  });

  it("treats regex metacharacters in keywords literally", () => {
    expect(matchRules("error 5.0 happened", [rule({ keywords: ["5.0"], priority: "high" })])?.keyword).toBe("5.0");
    expect(matchRules("error 500 happened", [rule({ keywords: ["5.0"], priority: "high" })])).toBeNull();
  });
});

describe("decidePriority", () => {
  const outage = matchRules("site is down", rules);

  it("uses the rule priority and its mention flag", () => {
    expect(decidePriority(outage, null)).toMatchObject({ priority: "high", source: "rule", mentionRole: true });
  });

  it("defaults to normal when nothing matches", () => {
    expect(decidePriority(null, null)).toMatchObject({ priority: "normal", source: "default", mentionRole: false });
  });

  it("lets AI escalate but never downgrade", () => {
    expect(decidePriority(outage, "critical")).toMatchObject({ priority: "critical", source: "ai" });
    expect(decidePriority(outage, "low")).toMatchObject({ priority: "high", source: "rule" });
  });

  it("always pings the alert role for critical reports", () => {
    expect(decidePriority(null, "critical").mentionRole).toBe(true);
  });

  it("maxPriority keeps the higher of two", () => {
    expect(maxPriority("high", "low")).toBe("high");
    expect(maxPriority(null, "low")).toBe("low");
    expect(maxPriority("normal", "critical")).toBe("critical");
  });
});
