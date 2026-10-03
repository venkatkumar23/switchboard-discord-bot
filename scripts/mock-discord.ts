// A stand-in for Discord's REST API and the AI provider, for the offline demo only.
// Answers the calls the Worker makes and prints each one, so you can see the bot "act".
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8790);
let nextMessageId = 1_400_000_000_000_000_000n;

const channels = [
  { id: "300000000000000001", name: "general", type: 0, position: 0 },
  { id: "300000000000000002", name: "mod-reports", type: 0, position: 1 },
  { id: "300000000000000003", name: "announcements", type: 5, position: 2 },
];
const roles = [
  { id: "200000000000000001", name: "@everyone", color: 0, position: 0, mentionable: false, managed: false },
  { id: "400000000000000001", name: "Moderators", color: 0xed4245, position: 2, mentionable: true, managed: false },
];

function triage(text: string) {
  const t = text.toLowerCase();
  if (/hack|phish|scam|token/.test(t)) return { summary: "Possible account compromise reported", category: "security", severity: "critical", tags: ["account"] };
  if (/down|crash|error|broken/.test(t)) return { summary: "Service outage affecting members", category: "outage", severity: "high", tags: ["outage"] };
  if (/typo|suggest/.test(t)) return { summary: "Minor content issue", category: "feedback", severity: "low", tags: ["content"] };
  return { summary: "General report from a member", category: "question", severity: "normal", tags: [] };
}

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const body = raw ? JSON.parse(raw) : null;
  const path = (req.url ?? "").split("?")[0]!;
  const send = (status: number, payload?: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload === undefined ? "" : JSON.stringify(payload));
  };
  console.log(`${req.method} ${path.replace(/(\/webhooks\/\d+\/)[^/]+/, "$1***")}${body?.content ? ` — ${String(body.content).split("\n")[0]}` : ""}`);

  if (path.startsWith("/ai/v1/chat/completions")) {
    const text = String(body?.messages?.[1]?.content ?? "");
    return send(200, { choices: [{ message: { content: JSON.stringify(triage(text)) } }] });
  }
  const guild = /\/guilds\/(\d+)$/.exec(path);
  if (guild) return send(200, { id: guild[1], name: "Demo Server", icon: null });
  if (/\/guilds\/\d+\/channels$/.test(path)) return send(200, channels);
  if (/\/guilds\/\d+\/roles$/.test(path)) return send(200, roles);
  if (/\/webhooks\/\d+\/[^/]+\/messages\/@original$/.test(path)) return send(200, { id: "1" });
  const post = /\/channels\/(\d+)\/messages$/.exec(path);
  if (post && req.method === "POST") return send(200, { id: String(nextMessageId++), channel_id: post[1] });
  if (/\/channels\/\d+\/messages\/\d+$/.test(path)) return send(200, { id: "1" });
  send(404, { message: "Unknown endpoint in mock", code: 0 });
}).listen(PORT, () => console.log(`Mock Discord + AI API listening on http://localhost:${PORT}`));
