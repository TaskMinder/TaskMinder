import { Request, RequestHandler } from "express";
import session from "express-session";
import { envConfig } from "./env.js";
import { redisClient, redisStore } from "./redis.js";
import { RedisStore, sessionTTLSeconds } from "./redis.session.js";

export const MODERATOR_SESSION_MS = 3 * 60 * 60 * 1000; // 3 hours
export const MODERATION_COOKIE = { name: "TaskMinderModeration", path: "/moderation" } as const;

// moderation panel's sessions, as long as panel login
const moderationRedisStore = new RedisStore({
  client: redisClient,
  prefix: "mod_sess:",
  ttlSeconds: MODERATOR_SESSION_MS / 1000
});

function createSession(
  store: RedisStore,
  name: string,
  cookie: { maxAge: number; sameSite: "lax" | "strict"; path?: string }
): RequestHandler {
  return session({
    store,
    proxy: envConfig.nodeEnv !== "DEVELOPMENT",
    secret: envConfig.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: { ...cookie, httpOnly: true, secure: envConfig.nodeEnv === "PRODUCTION" },
    name
  });
}

export function createSessionMiddlewares(): { sessionMiddleware: RequestHandler; moderationSessionMiddleware: RequestHandler } {
  return {
    sessionMiddleware: createSession(redisStore, "UserLogin", { sameSite: "lax", maxAge: sessionTTLSeconds * 1000 }),
    // moderation panel has own short session and cookie
    // stolen app cookie does not reach panel
    moderationSessionMiddleware: createSession(moderationRedisStore, MODERATION_COOKIE.name, {
      sameSite: "strict",
      maxAge: MODERATOR_SESSION_MS,
      path: MODERATION_COOKIE.path
    })
  };
}

// new session id on login and logout (-> session id known before cannot be used afterwards)
export function regenerateSession(
  req: Request,
  preservedData: { classId?: string; csrfToken?: string } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => {
      if (err) {
        reject(err);
        return;
      }
      if (preservedData.classId) {
        req.session.classId = preservedData.classId;
      }
      if (preservedData.csrfToken) {
        req.session.csrfToken = preservedData.csrfToken;
      }
      resolve();
    });
  });
}

export function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.destroy(err => (err ? reject(err) : resolve()));
  });
}
