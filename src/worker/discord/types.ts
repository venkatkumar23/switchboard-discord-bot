// The subset of Discord's interaction / message model this app uses.
// Payload shapes: https://docs.discord.com/developers/interactions/receiving-and-responding

export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
  MODAL_SUBMIT: 5,
} as const;

export const ResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
} as const;

export const ComponentType = {
  ACTION_ROW: 1,
  BUTTON: 2,
  TEXT_INPUT: 4,
  LABEL: 18,
} as const;

export const ButtonStyle = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4, LINK: 5 } as const;
export const TextInputStyle = { SHORT: 1, PARAGRAPH: 2 } as const;

export const MessageFlags = { EPHEMERAL: 1 << 6 } as const;

export const Permission = {
  ADMINISTRATOR: 1n << 3n,
  MANAGE_GUILD: 1n << 5n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  READ_MESSAGE_HISTORY: 1n << 16n,
} as const;

/** What the bot needs in a server: see/send/embed in channels, nothing more. */
export const BOT_PERMISSIONS = (
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.EMBED_LINKS |
  Permission.READ_MESSAGE_HISTORY
).toString();

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
}

export interface GuildMember {
  user: DiscordUser;
  nick?: string | null;
  /** Total permissions of the member in the channel, as a bitfield string. */
  permissions: string;
}

export interface CommandOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: CommandOption[];
}

export interface SubmittedComponent {
  type: number;
  custom_id?: string;
  value?: string;
  /** Label (type 18) wraps a single child. */
  component?: SubmittedComponent;
  /** Action rows (legacy modal layout) wrap several children. */
  components?: SubmittedComponent[];
}

export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  version: number;
  guild_id?: string;
  channel_id?: string;
  member?: GuildMember;
  user?: DiscordUser;
  data?: {
    id?: string;
    name?: string;
    type?: number;
    options?: CommandOption[];
    custom_id?: string;
    component_type?: number;
    components?: SubmittedComponent[];
  };
  message?: { id: string; channel_id: string };
}

export interface Embed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

export interface AllowedMentions {
  parse: ("roles" | "users" | "everyone")[];
  roles?: string[];
  users?: string[];
}

export interface MessagePayload {
  content?: string;
  embeds?: Embed[];
  components?: unknown[];
  allowed_mentions: AllowedMentions;
  flags?: number;
}

export interface InteractionResponse {
  type: number;
  data?: Record<string, unknown>;
}
