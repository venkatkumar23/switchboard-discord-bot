import type { CommandName, CommandSettings } from "../../shared/types";
import type { GuildRow } from "../db/rows";
import type { NewEvent } from "../db/queries";
import type { Env } from "../env";
import type { CommandOption, GuildMember, Interaction, InteractionResponse } from "../discord/types";

export interface Actor {
  id: string;
  name: string;
  permissions: bigint;
}

export interface InteractionContext {
  env: Env;
  db: D1Database;
  interaction: Interaction;
  now: number;
  guild: GuildRow;
  /** Settings of the command this interaction belongs to (buttons/modals → "report"). */
  settings: CommandSettings;
  user: Actor;
}

export interface HandlerResult {
  response: InteractionResponse;
  /** Stored on the interaction row: deferred | replied | modal | updated | rejected:<why> | error */
  outcome: string;
  /** Jobs the handler already committed to D1; started right after we respond. */
  jobs?: string[];
  /** Activity-log lines written after responding (the durable record is the interaction row). */
  events?: Omit<NewEvent, "guildId" | "interactionId">[];
}

export interface Route {
  /** Stored as interactions.name and used for per-user cooldowns. */
  name: string;
  command: CommandName;
  /** Subject to the enabled/cooldown rules (commands and the report form, not buttons). */
  gated: boolean;
  /** Keep the interaction token: needed only when we defer and edit the response later. */
  storeToken: boolean;
  handle: (ctx: InteractionContext) => Promise<HandlerResult>;
}

export function actorFrom(member: GuildMember): Actor {
  let permissions = 0n;
  try {
    permissions = BigInt(member.permissions);
  } catch {
    // malformed bitfield → no permissions
  }
  return {
    id: member.user.id,
    name: (member.nick || member.user.global_name || member.user.username || "unknown").slice(0, 80),
    permissions,
  };
}

export function optionValue(interaction: Interaction, name: string): CommandOption["value"] | undefined {
  return interaction.data?.options?.find((o) => o.name === name)?.value;
}
