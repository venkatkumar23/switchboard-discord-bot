import type { Context } from "hono";
import type { Env } from "./env";

export interface Admin {
  id: number;
  email: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: { admin: Admin; guildId: string };
};

export type AppContext = Context<AppEnv>;

/** Public origin used for OAuth redirects and links (APP_URL wins when configured). */
export function appOrigin(c: AppContext): string {
  return (c.env.APP_URL || new URL(c.req.url).origin).replace(/\/$/, "");
}

export const SNOWFLAKE = /^\d{17,20}$/;
