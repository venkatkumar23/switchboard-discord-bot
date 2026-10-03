// Helpers for the CLI scripts (run with tsx on Node 22).
import { existsSync } from "node:fs";

export function loadEnv(file = arg("env-file") ?? ".env"): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

export function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}: set it in .env (see .env.example) or in the environment.`);
    process.exit(1);
  }
  return value;
}

export const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
