import { randomInt } from "node:crypto";
import { RequestError } from "../@types/requestError.js";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function throwError(name: string, status: number, message: string, expected = true): never {
  const err: RequestError = { name, status, message, expected };
  throw err;
}

export function BigIntreplacer(key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function generateRandomBase62String(length = 20): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += BASE62[randomInt(0, BASE62.length)];
  }
  return result;
}
