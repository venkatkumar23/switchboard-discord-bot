/** Bindings, vars and secrets available to the Worker (see wrangler.jsonc and .env.example). */
export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;

  // Secrets
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_CLIENT_SECRET?: string;
  ENCRYPTION_KEY: string;
  AI_API_KEY?: string;

  // Plain vars
  DISCORD_API_BASE: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
  /** Public origin of the app. Optional: defaults to the incoming request's origin. */
  APP_URL?: string;
}
