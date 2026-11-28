import crypto from "crypto";
import { Request, Response, NextFunction } from "express";
import { RequestError } from "../@types/requestError.js";
import logger from "../config/logger.js";

const CSRF_TOKEN_BYTES = 32;
const CSRF_TOKEN_HEX_LENGTH = CSRF_TOKEN_BYTES * 2;

function throwCsrfUnauthorized(): never {
  const err: RequestError = {
    name: "Unauthorized",
    status: 401,
    message: "CSRF Check failed: Missing or invalid CSRF token. " +
      "This API is currently intended for browser-based usage only. " +
      "Please use the application via a web browser instead of calling the API directly.",
    expected: true
  };
  throw err;
}

function generateCSRFToken(): string {
  return crypto.randomBytes(CSRF_TOKEN_BYTES).toString("hex");
}

function isValidCsrfTokenFormat(providedToken: string, tokenFromSession: string): boolean {
  const isValidHexToken = (token: string): boolean => (
    token.length === CSRF_TOKEN_HEX_LENGTH
    && /^[a-f0-9]+$/i.test(token)
  );

  return isValidHexToken(providedToken) && isValidHexToken(tokenFromSession);
}

export function ensureCsrfSessionToken(req: Request): string {
  if (!req.session.csrfToken) {
    req.session.csrfToken = generateCSRFToken();
  }
  return req.session.csrfToken;
}

// GET handler for app and panel token; only pages of this site may read it
export function sendCsrfToken(req: Request, res: Response): void {
  const secFetchSite = req.header("sec-fetch-site");
  if (secFetchSite && !["same-origin", "same-site", "none"].includes(secFetchSite)) {
    res.status(403).json({ message: "Forbidden" });
    return;
  }
  const csrfToken = ensureCsrfSessionToken(req);
  res
    .set("Cache-Control", "no-store, no-cache, must-revalidate, private")
    .set("Pragma", "no-cache")  // HTTP/1.0 compat
    .set("Surrogate-Control", "no-store")
    .json({ csrfToken });
}

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
  function getProvidedToken(): unknown {
    const tokenFromHeader = req.headers["x-csrf-token"] as string | undefined;
    const tokenFromBody = req.body?.csrf ?? null;
  
    return tokenFromHeader || tokenFromBody;
  }

  const method = req.method.toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) {
    return next();
  }

  const tokenFromSession = req.session.csrfToken;
  const providedToken = getProvidedToken();

  if (
    !providedToken
    || typeof providedToken !== "string"
    || !tokenFromSession
    || typeof tokenFromSession !== "string"
    || !isValidCsrfTokenFormat(providedToken, tokenFromSession)
  ) {
    logger.warn("CSRF Check: Validation failed - Token missing or invalid type");
    throwCsrfUnauthorized();
  }

  const providedTokenBuffer = Buffer.from(providedToken, "utf8");
  const sessionTokenBuffer = Buffer.from(tokenFromSession, "utf8");

  if (providedTokenBuffer.length !== sessionTokenBuffer.length) {
    logger.warn("CSRF Check: Validation failed - Token length mismatch");
    throwCsrfUnauthorized();
  }

  let tokensMatch: boolean;
  try {
    tokensMatch = crypto.timingSafeEqual(providedTokenBuffer, sessionTokenBuffer);
  }
  catch (error) {
    logger.error(`CSRF Check: Unexpected error during token comparison: ${error}`);
    const err: RequestError = {
      name: "Internal Server Error",
      status: 500,
      message: "Internal Server Error",
      expected: false
    };
    throw err;
  }

  if (!tokensMatch) {
    logger.warn("CSRF Check: Validation failed - Tokens do not match");
    throwCsrfUnauthorized();
  }

  next();
}
