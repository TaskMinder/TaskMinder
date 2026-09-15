import * as dotenv from "dotenv";
dotenv.config();
import { createServer } from "http";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import express, { Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import session from "express-session";
import { prisma } from "./config/prisma.js";
import socketIO from "./config/socket.js";
import logger from "./config/logger.js";
import { connectRedis, redisStore } from "./config/redis.js";
import { sessionTTLSeconds } from "./config/redis.session.js";
import { startMetricsServer } from "./utils/metrics.server.js";
import {
  cleanupDeletedAccounts,
  cleanupOldEvents,
  cleanupOldHomework,
  cleanupTestClasses,
  cleanupStuckUploads,
  migrateEventAndHomeworkDates,
  migrateUploadMetadataDates
} from "./utils/db.cleanup.js";
import { initializeUploadWorkerServices, startUploadWorker } from "./utils/upload.process.worker.js";
import { cleanupStaleUploadFiles } from "./utils/upload.cleanup.js";
import { envConfig } from "./config/env.js";
import { BigIntreplacer } from "./utils/validate.functions.js";
import { prefetchSubstitutionDataForAllClasses } from "./services/substitution.service.js";
import checkAccess from "./middleware/access.middleware.js";
import { ErrorHandler } from "./middleware/error.middleware.js";
import { loggerMiddleware } from "./middleware/logger.middleware.js";
import { metricsMiddleware } from "./middleware/metrics.middleware.js";
import { CSPMiddleware } from "./middleware/CSP.middleware.js";
import { csrfProtection, ensureCsrfSessionToken } from "./middleware/csrfProtection.middleware.js";
import apiVersionMiddleware, { MAX_VERSION } from "./middleware/version.middleware.js";
import { authLimiter } from "./routes/account.route.js";
import accountService from "./services/account.service.js";
import account from "./routes/account.route.js";
import events from "./routes/event.route.js";
import homework from "./routes/homework.route.js";
import lessons from "./routes/lesson.route.js";
import substitutions from "./routes/substitution.route.js";
import subjects from "./routes/subject.route.js";
import teams from "./routes/team.route.js";
import classes from "./routes/class.route.js";
import uploads from "./routes/upload.route.js";
import statistics from "./routes/statistics.route.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sessionSecret = envConfig.sessionSecret;
const proxyHop = envConfig.proxyHop;

const app = express();
app.set("trust proxy", Number(proxyHop));
app.set("json replacer", BigIntreplacer);
const server = createServer(app);

app.use((req, res, next) => {
  const start = process.hrtime.bigint();

  const originalWriteHead = res.writeHead.bind(res);

  res.writeHead = ((...args: Parameters<typeof res.writeHead>) => {
    if (!res.headersSent) {
      const durationMs =
        Number(process.hrtime.bigint() - start) / 1e6;

      res.setHeader(
        "Server-Timing",
        `total;dur=${durationMs.toFixed(2)}`
      );
    }

    return originalWriteHead(...args);
  }) as typeof res.writeHead;

  next();
});

const globalLimiter = rateLimit({
  windowMs: 1000, // 1 second
  limit: 125, // Max 125 requests per IP per second
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { status: 429, message: "Too many requests, please slow down." }
});
app.use(globalLimiter);

const csrfTokenLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { status: 429, message: "Too many CSRF token requests, please slow down." }
});

app.use(CSPMiddleware());

app.use(express.static("frontend/dist"));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const sessionMiddleware = session({
  store: redisStore,
  proxy: envConfig.nodeEnv !== "DEVELOPMENT",
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    sameSite: "lax",
    maxAge: sessionTTLSeconds * 1000, // 30 days
    httpOnly: true,
    secure: envConfig.nodeEnv === "PRODUCTION"
  },
  name: "UserLogin"
});

app.get("/health", (req, res) => {
  res.status(200).json({ message: "service operational" });
});

socketIO.initialize(server, sessionMiddleware);

app.use(sessionMiddleware);

app.get("/bootstrap", authLimiter, async (req, res, next) => {
  try {
    const auth = await accountService.getAuth(req.session);

    const cacheEnabled =
      envConfig.nodeEnv !== "DEVELOPMENT" ||
      envConfig.cacheEnabled;

    const version = MAX_VERSION;
    
    res.set("Cache-Control", "no-store");
    res.status(200).json({ maintenance: false, classJoined: auth.classJoined, version, cacheEnabled });
  }
  catch (error) {
    next(error);
  }
});

app.get("/csrf-token", csrfTokenLimiter, (req, res) => {
  const secFetchSite = req.header("sec-fetch-site");
  if (secFetchSite && !["same-origin", "same-site", "none"].includes(secFetchSite)) {
    return res.status(403).json({ message: "Forbidden" });
  }
  const csrfToken = ensureCsrfSessionToken(req);
  res
    .set("Cache-Control", "no-store, no-cache, must-revalidate, private")
    .set("Pragma", "no-cache")  // HTTP/1.0 compat
    .set("Surrogate-Control", "no-store") // CDN layer
    .json({ csrfToken });
});
app.use(csrfProtection);
app.use(metricsMiddleware);
app.use(loggerMiddleware);

app.get("/", (req: Request, res: Response) => {
  res.sendFile(path.join(pagesPath, "landing", "landing.html"));
});

const pagesPath = path.join(__dirname, "..", "..", "frontend", "dist", "pages");

app.get("/join", (req, res) => {
  const action = req.query.action;
  const legacyOrigin = Object.hasOwn(req.query, "legacy_origin") ? "legacy_origin" : "";

  if (req.session.account && req.session.classId) {
    return res.redirect(302, legacyOrigin ? `/main?${legacyOrigin}` : "/main");
  }

  if (!req.session.account && req.session.classId) {
    if (action !== "account") {
      return res.redirect(302, `/join?action=account${legacyOrigin ? `&${legacyOrigin}` : ""}`);
    }
  }
  res.sendFile(path.join(pagesPath, "join", "join.html"));
});

app.get("/settings", (req, res) => {
  res.sendFile(path.join(pagesPath, "settings", "settings.html"));
});

app.get("/about", (req, res) => {
  res.sendFile(path.join(pagesPath, "about", "about.html"));
});

app.use("/stats", statistics);

// Apply API version check only to API routes
app.use("/api", apiVersionMiddleware);

app.use("/api/account", account);
app.use("/api/homework", homework);
app.use("/api/substitutions", substitutions);
app.use("/api/teams", teams);
app.use("/api/events", events);
app.use("/api/subjects", subjects);
app.use("/api/lessons", lessons);
app.use("/api/classes", classes);
app.use("/api/uploads", uploads);

//
// Protected routes: Redirect to /join if not logged in
//
app.get("/main", checkAccess(["CLASS"]), (req, res) => {
  res.sendFile(path.join(pagesPath, "main", "main.html"));
});

app.get("/homework", checkAccess(["CLASS"]), (req, res) => {
  res.sendFile(path.join(pagesPath, "homework", "homework.html"));
});

app.get("/events", checkAccess(["CLASS"]), (req, res) => {
  res.sendFile(path.join(pagesPath, "events", "events.html"));
});

app.get("/uploads", checkAccess(["CLASS"]), (req, res) => {
  res.sendFile(path.join(pagesPath, "uploads", "uploads.html"));
});

// Development only route; in production, the landing page is at taskminder.de
app.get("/landing", (req, res) => {
  res.redirect(302, "/");
});

app.use((req, res) => {
  const ext = path.extname(req.path);

  switch (ext) {
  case ".css":
    res.status(404).sendFile(path.join(pagesPath, "404", "404.css"));
    break;
  case ".js":
    res.status(404).sendFile(path.join(pagesPath, "404", "404.js"));
    break;
  default:
    res.status(404).sendFile(path.join(pagesPath, "404", "404.html"));
    break;
  }
});

// Error Handler Middleware (Must be the last app.use)
app.use(ErrorHandler);

// Schedule the cron job to run at midnight (00:00) every day
cron.schedule("0 0 * * *", () => {
  logger.info("Starting scheduled daily cleanup");
  cleanupOldHomework();
  cleanupOldEvents();
  cleanupDeletedAccounts();
  cleanupStaleUploadFiles();
});

// Run demo class script every week (once) - only for demo class
// This is not relevant if you do not have a demo class set up
cron.schedule("0 0 * * 0", () => {
  logger.info("Starting weekly demo class date migration");
  migrateEventAndHomeworkDates();
  migrateUploadMetadataDates();
});

// Run test class deletion every 15mins
cron.schedule("*/15 * * * *", () => {
  cleanupTestClasses();
});

// Prefetch substitutions every minute during weekday mornings (06:00-08:59)
cron.schedule("*/1 6-8 * * 1-5", () => {
  logger.info("Starting scheduled substitution prefetch");
  prefetchSubstitutionDataForAllClasses().catch(err => {
    logger.error(`Scheduled substitution prefetch failed: ${err}`);
  });
});

// Run stuck upload cleanup every 10 minutes
setInterval(() => {
  logger.info("Running stuck upload cleanup");
  cleanupStuckUploads().catch(err => {
    logger.error(`Stuck upload cleanup failed: ${err}`);
  });
}, 10 * 60 * 1000); // 10 minutes

const bootstrap = async (): Promise<void> => {
  try {
    await prisma.$connect();
    logger.info("Connected to Database");

    await connectRedis();
    await initializeUploadWorkerServices();

    void startUploadWorker().catch(err => {
      logger.error(`Upload worker failed unexpectedly: ${err}`);
    });

    server.listen(3000, () => {
      logger.info("Server running at http://localhost:3000");
      startMetricsServer();
    });
  }
  catch (err) {
    logger.error(`Startup failed: ${err}`);
    process.exit(1);
  }
};

void bootstrap();
