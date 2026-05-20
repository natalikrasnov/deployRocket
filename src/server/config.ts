import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config();

const rootDir = process.cwd();
const isServerlessRuntime = process.env.SERVERLESS === "true" || process.env.VERCEL === "1";
const writableRootDir = isServerlessRuntime
  ? path.join(process.env.TMPDIR ?? "/tmp", "deployrocket")
  : rootDir;

export const paths = {
  rootDir,
  dataDir: path.join(writableRootDir, "data"),
  uploadsDir: path.join(writableRootDir, "uploads"),
  generatedDir: path.join(writableRootDir, "generated"),
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
    process.env.GITHUB_CALLBACK_URL?.trim() || "/auth/github/callback",
  sessionSecret: process.env.SESSION_SECRET?.trim() || "replace-this-session-secret",
  githubDefaultBranch: process.env.GITHUB_DEFAULT_BRANCH ?? "main",
  vercelToken: process.env.VERCEL_TOKEN?.trim() ?? "",
  vercelTeamId: process.env.VERCEL_TEAM_ID?.trim() ?? "",
  vercelTeamSlug: process.env.VERCEL_TEAM_SLUG?.trim() ?? "",
  vercelTarget: process.env.VERCEL_TARGET?.trim() || "production",
  isServerless: isServerlessRuntime,
  githubProjectTopic: process.env.GITHUB_PROJECT_TOPIC?.trim() || "deployrocket-project",
  githubStateBranch: process.env.GITHUB_STATE_BRANCH?.trim() || "deployrocket-state",
  frontendOrigins: (
    process.env.FRONTEND_ORIGIN ?? "http://localhost:5173,http://127.0.0.1:5173"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  frontendUrl: process.env.FRONTEND_URL?.trim() ?? "",
  isProduction: process.env.NODE_ENV === "production"
};

export function getMissingConfig() {
  const missing: string[] = [];

  if (!config.openaiApiKey) missing.push("OPENAI_API_KEY");
  if (!config.githubClientId) missing.push("GITHUB_CLIENT_ID");
  if (!config.githubClientSecret) missing.push("GITHUB_CLIENT_SECRET");
  if (!config.githubCallbackUrl) missing.push("GITHUB_CALLBACK_URL");
  if (!config.vercelToken) missing.push("VERCEL_TOKEN");
  if (!config.sessionSecret || config.sessionSecret === "replace-this-session-secret") {
    missing.push("SESSION_SECRET");
  }
  return missing;
}

export function isGithubOAuthConfigured() {
  return Boolean(config.githubClientId && config.githubClientSecret && config.githubCallbackUrl);
}

export function isVercelConfigured() {
  return Boolean(config.vercelToken);
}
