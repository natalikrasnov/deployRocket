import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import crypto from "node:crypto";
import fs from "node:fs";
import multer from "multer";
import path from "node:path";
import { config, paths } from "./config.js";
import { githubManager } from "./agents/githubManager.js";
import { orchestrator } from "./agents/orchestrator.js";
import { pagesDeployManager } from "./agents/pagesDeployManager.js";
import { AppError, toReadableError } from "./lib/errors.js";
import { createId, nowIso } from "./lib/id.js";
import { projectStore, runningProjectStatuses } from "./state/projectStore.js";
import { requestContext, setGithubAuthInContext } from "./state/requestContext.js";
import type { GitHubAuthState } from "./state/authStore.js";
import type { ProjectError, ProjectInputImage, ProjectInputRecord } from "../shared/types.js";

const app = express();

const upload = multer({
  dest: paths.uploadsDir,
  limits: {
    files: 4,
    fileSize: 8 * 1024 * 1024
  },
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype.startsWith("image/")) {
      callback(
        new AppError("Only image uploads are supported.", {
          statusCode: 400,
          code: "INVALID_UPLOAD_TYPE"
        })
      );
      return;
    }
    callback(null, true);
  }
});

app.use(
  cors({
    origin: config.frontendOrigins,
    credentials: true
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: config.isProduction || config.isServerless ? "none" : "lax",
      secure: config.isProduction || config.isServerless
    }
  })
);
app.use((req, res, next) => {
  ensureBrowserSession(req, res);
  const github = readEncryptedJsonCookie<GitHubAuthState>(req, GITHUB_AUTH_COOKIE);
  requestContext.run({ github }, () => next());
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, at: nowIso() });
});

app.get("/api/setup", async (req, res, next) => {
  try {
    res.json(await githubManager.getSetupStatus(githubSessionIdFrom(req)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/github", async (req, res, next) => {
  try {
    res.json(await githubManager.getSetupStatus(githubSessionIdFrom(req)));
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/github/disconnect", async (req, res, next) => {
  try {
    await githubManager.disconnect(githubSessionIdFrom(req));
    clearCookie(res, GITHUB_AUTH_COOKIE);
    setGithubAuthInContext(null);
    res.json(await githubManager.getSetupStatus(githubSessionIdFrom(req)));
  } catch (error) {
    next(error);
  }
});

app.get("/auth/github", (req, res, next) => {
  try {
    const state = createId("github_state");
    (req.session as typeof req.session & { githubOauthState?: string }).githubOauthState = state;
    setSignedCookie(res, GITHUB_STATE_COOKIE, state, 10 * 60);
    res.redirect(githubManager.getAuthorizationUrl(state));
  } catch (error) {
    next(error);
  }
});

app.get("/auth/github/callback", async (req, res, next) => {
  try {
    const state = String(req.query.state ?? "");
    const expectedState =
      (req.session as typeof req.session & { githubOauthState?: string }).githubOauthState ??
      readSignedCookie(req, GITHUB_STATE_COOKIE);

    if (!state || !expectedState || state !== expectedState) {
      throw new AppError("GitHub OAuth state mismatch.", {
        statusCode: 400,
        code: "GITHUB_OAUTH_STATE_MISMATCH"
      });
    }

    const code = String(req.query.code ?? "");
    if (!code) {
      throw new AppError("GitHub OAuth did not return an authorization code.", {
        statusCode: 400,
        code: "GITHUB_OAUTH_CODE_MISSING"
      });
    }

    const auth = await githubManager.exchangeCode(githubSessionIdFrom(req), code);
    delete (req.session as typeof req.session & { githubOauthState?: string }).githubOauthState;
    clearCookie(res, GITHUB_STATE_COOKIE);
    setEncryptedJsonCookie(res, GITHUB_AUTH_COOKIE, auth, 60 * 60 * 24 * 30);
    setGithubAuthInContext(auth);
    res.redirect(frontendRedirect("?github=connected"));
  } catch (error) {
    if (error instanceof AppError) {
      res.redirect(frontendRedirect(`?github=error&code=${encodeURIComponent(error.code)}`));
      return;
    }
    next(error);
  }
});

app.get("/api/projects", async (_req, res, next) => {
  try {
    res.json(await projectStore.listProjects());
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects", upload.array("images", 4), async (req, res, next) => {
  try {
    const input = buildInputRecord("create", req);
    const project = await projectStore.createProject(input);
    await orchestrator.start(project.id, input.id, "create", githubSessionIdFrom(req));
    const latest = config.isServerless
      ? await orchestrator.runNextStep(project.id, githubSessionIdFrom(req))
      : await projectStore.getProject(project.id);
    res.status(202).json(latest);
  } catch (error) {
    next(error);
  }
});

app.get("/api/projects/:id", async (req, res, next) => {
  try {
    const project = await projectStore.getProject(projectIdFrom(req));
    if (!project) throw notFound();
    res.json(project);
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/edit", upload.array("images", 4), async (req, res, next) => {
  try {
    const project = await projectStore.getProject(projectIdFrom(req));
    if (!project) throw notFound();

    const forceStop = String(req.body.forceStop ?? "false") === "true";
    if (projectStore.isRunning(project.status) && !forceStop) {
      throw new AppError("The project is currently running.", {
        statusCode: 409,
        code: "PROJECT_RUNNING",
        details: "Editing will stop the current process."
      });
    }

    if (projectStore.isRunning(project.status)) {
      await orchestrator.stop(project.id);
    }

    const input = buildInputRecord("edit", req);
    await projectStore.addInput(project.id, input);
    await orchestrator.start(project.id, input.id, "edit", githubSessionIdFrom(req));
    const latest = config.isServerless
      ? await orchestrator.runNextStep(project.id, githubSessionIdFrom(req))
      : await projectStore.getProject(project.id);
    res.status(202).json(latest);
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/stop", async (req, res, next) => {
  try {
    const project = await projectStore.getProject(projectIdFrom(req));
    if (!project) throw notFound();
    await orchestrator.stop(project.id);
    res.json(await projectStore.getProject(project.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/run", async (req, res, next) => {
  try {
    const project = await projectStore.getProject(projectIdFrom(req));
    if (!project) throw notFound();
    const nextProject = await orchestrator.runNextStep(project.id, githubSessionIdFrom(req));
    res.json(nextProject);
  } catch (error) {
    next(error);
  }
});

app.post("/api/projects/:id/refresh", async (req, res, next) => {
  try {
    const project = await projectStore.getProject(projectIdFrom(req));
    if (!project) throw notFound();
    const refreshed = await orchestrator.refreshDeployment(project.id, githubSessionIdFrom(req));
    res.json(refreshed);
  } catch (error) {
    next(error);
  }
});

if (fs.existsSync(paths.clientDistDir)) {
  app.use(express.static(paths.clientDistDir));
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api") && !req.path.startsWith("/auth")) {
      res.sendFile(path.join(paths.clientDistDir, "index.html"));
      return;
    }
    next();
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const readable = toReadableError(error);
  res.status(readable.statusCode).json({
    error: {
      message: readable.message,
      code: readable.code,
      details: readable.details,
      setupInstructions: readable.setupInstructions
    }
  });
});

async function bootstrap() {
  const recovered = await projectStore.recoverInterruptedProjects();
  if (recovered.length > 0) {
    console.warn(`Recovered ${recovered.length} interrupted project run(s) as STOPPED.`);
  }

  app.listen(config.port, () => {
    console.log(`deployRocket backend running on http://localhost:${config.port}`);
  });

}


const SESSION_COOKIE = "deployrocket_sid";
const GITHUB_STATE_COOKIE = "deployrocket_github_state";
const GITHUB_AUTH_COOKIE = "deployrocket_github_auth";

function ensureBrowserSession(req: Request, res: Response) {
  const existing = readSignedCookie(req, SESSION_COOKIE);
  if (existing) {
    (req as Request & { deployRocketSessionId?: string }).deployRocketSessionId = existing;
    return existing;
  }

  const nextSessionId = createId("session");
  (req as Request & { deployRocketSessionId?: string }).deployRocketSessionId = nextSessionId;
  setSignedCookie(res, SESSION_COOKIE, nextSessionId, 60 * 60 * 24 * 365);
  return nextSessionId;
}

function readSignedCookie(req: Request, name: string) {
  const raw = readCookie(req, name);
  if (!raw) return null;

  const signed = decodeURIComponent(raw);
  const separator = signed.lastIndexOf(".");
  if (separator <= 0) return null;

  const value = signed.slice(0, separator);
  const signature = signed.slice(separator + 1);
  const expected = signCookieValue(value);
  if (!timingSafeEqual(signature, expected)) return null;
  return value;
}

function setSignedCookie(res: Response, name: string, value: string, maxAgeSeconds: number) {
  const signed = value + "." + signCookieValue(value);
  appendCookie(
    res,
    name + "=" + encodeURIComponent(signed) + "; " + cookieAttributes(maxAgeSeconds)
  );
}

function clearCookie(res: Response, name: string) {
  appendCookie(res, name + "=; " + cookieAttributes(0));
}

function setEncryptedJsonCookie<T>(res: Response, name: string, value: T, maxAgeSeconds: number) {
  appendCookie(res, name + "=" + encodeURIComponent(sealJson(value)) + "; " + cookieAttributes(maxAgeSeconds));
}

function readEncryptedJsonCookie<T>(req: Request, name: string) {
  const raw = readCookie(req, name);
  if (!raw) return null;
  try {
    return openJson<T>(decodeURIComponent(raw));
  } catch {
    return null;
  }
}

function appendCookie(res: Response, value: string) {
  res.append("Set-Cookie", value);
}

function cookieAttributes(maxAgeSeconds: number) {
  const sameSite = config.isProduction || config.isServerless ? "None" : "Lax";
  const secure = config.isProduction || config.isServerless ? "; Secure" : "";
  return "Path=/; HttpOnly; Max-Age=" + maxAgeSeconds + "; SameSite=" + sameSite + secure;
}

function readCookie(req: Request, name: string) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";").map((part) => part.trim());
  const match = cookies.find((cookie) => cookie.startsWith(name + "="));
  return match ? match.slice(name.length + 1) : null;
}

function signCookieValue(value: string) {
  return crypto.createHmac("sha256", config.sessionSecret).update(value).digest("base64url");
}

function sealJson<T>(value: T) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString("base64url")).join(".");
}

function openJson<T>(sealed: string) {
  const [ivText, tagText, encryptedText] = sealed.split(".");
  if (!ivText || !tagText || !encryptedText) return null;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivText, "base64url")
  );
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final()
  ]).toString("utf8");
  return JSON.parse(decrypted) as T;
}

function encryptionKey() {
  return crypto.createHash("sha256").update(config.sessionSecret).digest();
}

function timingSafeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function buildInputRecord(kind: "create" | "edit", req: Request): ProjectInputRecord {
  const text = String(req.body.text ?? "").trim();
  const files = (req.files ?? []) as Express.Multer.File[];

  if (!text && files.length === 0) {
    throw new AppError("Project input cannot be empty.", {
      statusCode: 400,
      code: "EMPTY_PROMPT"
    });
  }

  const images: ProjectInputImage[] = files.map((file) => ({
    id: createId("image"),
    originalName: file.originalname,
    storedName: file.filename,
    mimeType: file.mimetype,
    size: file.size,
    path: file.path
  }));

  return {
    id: createId("input"),
    kind,
    text,
    images,
    createdAt: nowIso()
  };
}

function notFound() {
  return new AppError("Project not found.", {
    statusCode: 404,
    code: "PROJECT_NOT_FOUND"
  });
}

function projectIdFrom(req: Request) {
  return String(req.params.id);
}

function githubSessionIdFrom(req: Request) {
  return (req as Request & { deployRocketSessionId?: string }).deployRocketSessionId ?? req.sessionID;
}

function frontendRedirect(query = "") {
  if (config.frontendUrl) {
    const url = new URL(config.frontendUrl);
    url.search = query.startsWith("?") ? query : query ? `?${query}` : "";
    return url.toString();
  }

  if (fs.existsSync(path.join(paths.clientDistDir, "index.html"))) {
    return `/${query}`;
  }
  return `http://localhost:5173/${query}`;
}

function startStatusPoller() {
  setInterval(async () => {
    const projects = await projectStore.listProjects();
    for (const project of projects) {
      if (
        runningProjectStatuses.includes(project.status) &&
        project.status === "DEPLOYING" &&
        !orchestrator.isActive(project.id)
      ) {
        try {
          if (!project.githubUserLogin) continue;
          const githubSessionId = await githubManager.findSessionIdForUser(project.githubUserLogin);
          if (!githubSessionId) continue;
          await pagesDeployManager.pollProject(project, githubSessionId);
        } catch (error) {
          const readable = toReadableError(error);
          const projectError: ProjectError = {
            message: readable.message,
            code: readable.code,
            details: readable.details,
            setupInstructions: readable.setupInstructions,
            at: nowIso()
          };
          await projectStore.failProject(project.id, projectError);
        }
      }
    }
  }, 15000).unref();
}

if (!config.isServerless) {
  bootstrap().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { app };
export default app;
