/**
 * Express middleware that validates the X-API-Version header.
 * Accepts clients whose version falls within [MIN_VERSION, MAX_VERSION].
 * Expects strict semantic versioning: MAJOR.MINOR.PATCH (e.g. 2.2.5)
 */
import { NextFunction, Request, Response } from "express";
import { RequestError } from "../@types/requestError.js";
import logger from "../config/logger.js";

export const MIN_VERSION = "2.3.1";
export const MAX_VERSION = "2.3.1";

const SEMVER_REGEX = /^\d+\.\d+\.\d+$/;
const ACCEPTED_RANGE = `${MIN_VERSION} - ${MAX_VERSION}`;

for (const [name, value] of [["API_MIN_VERSION", MIN_VERSION], ["API_MAX_VERSION", MAX_VERSION]]) {
  if (!SEMVER_REGEX.test(value)) {
    throw new Error(`Invalid ${name}: "${value}". Expected semver e.g. 1.2.3`);
  }
}

function compareSemver(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = a.split(".").map(Number);
  const [bMajor, bMinor, bPatch] = b.split(".").map(Number);

  if (aMajor !== bMajor) return aMajor - bMajor;
  if (aMinor !== bMinor) return aMinor - bMinor;
  return aPatch - bPatch;
}

if (compareSemver(MIN_VERSION, MAX_VERSION) > 0) {
  logger.error("MIN_VERSION or MAX_VERSION are not acceptable");
  throw new Error(
    `Invalid version range: API_MIN_VERSION (${MIN_VERSION}) cannot be greater than API_MAX_VERSION (${MAX_VERSION})`
  );
}

export default function apiVersionMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip version check for this route (/api/events/types/styles)
  // Else frontend has to fetch manually and add the textContent in a <style>
  // through we are not that strict, but it would not adhere to CSP-standards.
  // The problem is that <link> does not offer a possibility to set a header 
  // and setting it in SW since the type is no-cors, so immutable...
  if (req.path === "/events/types/styles" || (/\/uploads\/\d+/.exec(req.path) && req.method === "GET")) {
    return next();
  }

  const rawClientVersion = req.headers["x-api-version"];
  const clientVersion = Array.isArray(rawClientVersion)
    ? rawClientVersion.length === 1
      ? rawClientVersion[0]
      : undefined
    : rawClientVersion;

  if (!clientVersion) {
    const err: RequestError = {
      name: "Bad Request",
      status: 400,
      message: "Missing X-API-Version header",
      expected: true
    };
    throw err;
  }

  if (!SEMVER_REGEX.test(clientVersion)) {
    const err: RequestError = {
      name: "Bad Request",
      status: 400,
      message: `Invalid X-API-Version: "${clientVersion}". Expected semver e.g. 1.2.3`,
      expected: true
    };
    throw err;
  }

  if (compareSemver(clientVersion, MIN_VERSION) < 0) {
    const err: RequestError = {
      name: "Upgrade Required",
      status: 426,
      message: `Client version ${clientVersion} is below the minimum supported version ${MIN_VERSION}, Accepted Range: ${ACCEPTED_RANGE}`,
      expected: true
    };
    throw err;
  }

  if (compareSemver(clientVersion, MAX_VERSION) > 0) {
    const err: RequestError = {
      name: "Upgrade Required",
      status: 426,
      message: `Client version ${clientVersion} exceeds the maximum supported version ${MAX_VERSION}, Accepted Range: ${ACCEPTED_RANGE}`,
      expected: true
    };
    throw err;
  }

  req.apiVersion = clientVersion;
  return next();
}