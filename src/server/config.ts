import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config();

const rootDir = process.cwd();

export const paths = {
  rootDir,
  dataDir: path.join(rootDir, "data"),
  uploadsDir: path.join(rootDir, "uploads"),
  generatedDir: path.join(rootDir, "data", "generated"),
  clientDistDir: path.join(rootDir, "dist", "client")
};

for (const dir of [paths.dataDir, paths.uploadsDir, paths.generatedDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-5.2",
  openaiCodexModel: process.env.OPENAI_CODEX_MODEL ?? "gpt-5.2-codex",
  githubClientId: process.env.GITHUB_CLIENT_ID?.trim() ?? "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET?.trim() ?? "",
  githubCallbackUrl:
    process.env.GITHUB_CALLBACK_URL?.trim() || "http://localhost:3000/auth/github/callback",
  sessionSecret: process.env.SESSION_SECRET?.trim() || "replace-this-session-secret",
  githubDefaultBranch: process.env.GITHUB_DEFAULT_BRANCH ?? "main",
  isProduction: process.env.NODE_ENV === "production"
};

export function getMissingConfig() {
  const missing: string[] = [];

  if (!config.openaiApiKey) missing.push("OPENAI_API_KEY");
  if (!config.githubClientId) missing.push("GITHUB_CLIENT_ID");
  if (!config.githubClientSecret) missing.push("GITHUB_CLIENT_SECRET");
  if (!config.githubCallbackUrl) missing.push("GITHUB_CALLBACK_URL");
  if (!config.sessionSecret || config.sessionSecret === "replace-this-session-secret") {
    missing.push("SESSION_SECRET");
  }

  return missing;
}

export function isGithubOAuthConfigured() {
  return Boolean(config.githubClientId && config.githubClientSecret && config.githubCallbackUrl);
}
