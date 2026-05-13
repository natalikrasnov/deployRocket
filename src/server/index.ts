import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
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
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
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
      sameSite: "lax",
      secure: config.isProduction
    }
  })
);

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
    res.json(await githubManager.getSetupStatus(githubSessionIdFrom(req)));
  } catch (error) {
    next(error);
  }
});

app.get("/auth/github", (req, res, next) => {
  try {
    const state = createId("github_state");
    (req.session as typeof req.session & { githubOauthState?: string }).githubOauthState = state;
    res.redirect(githubManager.getAuthorizationUrl(state));
  } catch (error) {
    next(error);
  }
});

app.get("/auth/github/callback", async (req, res, next) => {
  try {
    const state = String(req.query.state ?? "");
    const expectedState = (req.session as typeof req.session & { githubOauthState?: string })
      .githubOauthState;

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

    await githubManager.exchangeCode(githubSessionIdFrom(req), code);
    delete (req.session as typeof req.session & { githubOauthState?: string }).githubOauthState;
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
    orchestrator.start(project.id, input.id, "create", githubSessionIdFrom(req));
    res.status(202).json(await projectStore.getProject(project.id));
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
    orchestrator.start(project.id, input.id, "edit", githubSessionIdFrom(req));
    res.status(202).json(await projectStore.getProject(project.id));
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

  startStatusPoller();
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
  return req.sessionID;
}

function frontendRedirect(query = "") {
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

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
