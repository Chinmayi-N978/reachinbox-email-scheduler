import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve candidate paths for .env:
// 1. backend/.env relative to compiled/source file: path.resolve(__dirname, "../.env")
// 2. process.cwd()/.env (if executed from inside backend/)
// 3. process.cwd()/backend/.env (if executed from repository root)
export const candidatePaths = [
  path.resolve(__dirname, "../.env"),
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "backend/.env"),
];

/**
 * Loads or hot-reloads environment variables from disk with override: true.
 * Ensures any edits to .env on disk immediately take effect in process.env.
 */
export function reloadEnv(): boolean {
  for (const envPath of candidatePaths) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, override: true });
      return true;
    }
  }
  dotenv.config({ override: true });
  return false;
}

// Initial load on import
reloadEnv();

export const isConfigLoaded = true;
