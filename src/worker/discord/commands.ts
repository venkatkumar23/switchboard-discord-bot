// Slash command definitions. Shared by the Worker (dispatch) and scripts/register-commands.ts
// (registration), so the two can never drift apart.

const GUILD_INSTALL = 0;
const GUILD_CONTEXT = 0;
const STRING = 3;
const INTEGER = 4;

export const REPORT_TEXT_MAX = 1500;

export const COMMANDS = [
  {
    name: "report",
    description: "Report a problem to the moderators (leave text empty to open a form)",
    type: 1,
    integration_types: [GUILD_INSTALL],
    contexts: [GUILD_CONTEXT],
    options: [
      {
        type: STRING,
        name: "text",
        description: "What happened? Leave empty to open a form instead",
        required: false,
        max_length: REPORT_TEXT_MAX,
      },
    ],
  },
  {
    name: "status",
    description: "Show open reports and bot health, or the status of one report",
    type: 1,
    integration_types: [GUILD_INSTALL],
    contexts: [GUILD_CONTEXT],
    options: [
      {
        type: INTEGER,
        name: "report",
        description: "Report number, e.g. 42",
        required: false,
        min_value: 1,
      },
    ],
  },
] as const;

export const COMMAND_DESCRIPTIONS: Record<(typeof COMMANDS)[number]["name"], string> = {
  report: "Files a report: records it, applies keyword rules + AI triage, replies, posts it with buttons, mirrors it.",
  status: "Answers with open-report counts and pipeline health, or the state of one report.",
};
