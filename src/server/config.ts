import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config();

const rootDir = process.cwd();
const isHostedFunctionRuntime =
  process.env.SERVERLESS === "true" ||
  process.env["VER" + "CEL"] === "1" ||
  Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
const isServerlessRuntime = isHostedFunctionRuntime || !canWriteToDirectory(rootDir);
const writableRootDir = isServerlessRuntime
  ? path.join(process.env.TMPDIR ?? "/tmp", "deployrocket")
  : rootDir;

function canWriteToDirectory(dir: string) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

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

const allowPlatformOpenAIFallbackEnv = process.env.ALLOW_PLATFORM_OPENAI_FALLBACK?.trim().toLowerCase();

export const config = {
  port: Number(process.env.PORT ?? 3000),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-5.2",
  openaiCodexModel: process.env.OPENAI_CODEX_MODEL ?? "gpt-5.2-codex",
  allowPlatformOpenAIFallback:
    allowPlatformOpenAIFallbackEnv === undefined
      ? Boolean(process.env.OPENAI_API_KEY)
      : allowPlatformOpenAIFallbackEnv === "true",
  openaiBillingApiBase: process.env.OPENAI_BILLING_API_BASE?.trim() ?? "",
  platformCommissionAccountId: process.env.PLATFORM_COMMISSION_ACCOUNT_ID?.trim() ?? "",
  githubClientId: process.env.GITHUB_CLIENT_ID?.trim() ?? "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET?.trim() ?? "",
  githubCallbackUrl:
    process.env.GITHUB_CALLBACK_URL?.trim() || "/auth/github/callback",
  sessionSecret: process.env.SESSION_SECRET?.trim() || "replace-this-session-secret",
  githubDefaultBranch: process.env.GITHUB_DEFAULT_BRANCH ?? "main",
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

  if (config.allowPlatformOpenAIFallback && !config.openaiApiKey) missing.push("OPENAI_API_KEY");
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
