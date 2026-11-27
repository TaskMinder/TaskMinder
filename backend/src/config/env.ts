function failEnv(message: string): never {
  // use console.error and not logger.error since this would result in a circular dependency
  console.error(message);
  process.exit(1);
}

export type EnvConfig = {
  nodeEnv: "DEVELOPMENT" | "PRODUCTION";
  sessionSecret: string;
  databaseUrl: string;
  proxyHop: number;
  cacheEnabled: boolean;
  encryptionKey: string;
  encryptionKeySecondary: string;
  encryptionKeyLookup: string;
  brevoApiKey: string | null;
  moderationPassword: string | null;
};

export function requireNodeEnv(): string {
  const nodeEnv = process.env.NODE_ENV;
  if (!nodeEnv || (nodeEnv !== "DEVELOPMENT" && nodeEnv !== "PRODUCTION")){
    failEnv("NODE_ENV is undefined or not set to DEVELOPMENT or PRODUCTION! Please define in the .env file.");
  }
  return nodeEnv;
}

export function requireCacheEnabled(): string {
  const cacheEnabled = process.env.CACHE_ENABLED;
  if (!cacheEnabled){
    failEnv("CACHE_ENABLED is undefined! Please define in the .env file.");
  }
  return cacheEnabled;
}


export function requireProxyHop(): string {
  const proxyHop = process.env.PROXY_HOP;
  if (!proxyHop || !Number.isInteger(Number(proxyHop)) || Number(proxyHop) < 0) {
    failEnv("PROXY_HOP is undefined or/and must be a positive integer. Please define in the .env file.");
  }
  return proxyHop;
}

export function requireSessionSecret(): string {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret){
    failEnv("SESSION_SECRET is undefined! Please define in the .env file.");
  }
  return sessionSecret;
}

export function requireBase64Key(key: string): string {
  const base64EncryptionKey = process.env[key];
  if (!base64EncryptionKey){
    failEnv(`${key} is undefined! Please define in the .env file.`);
  }
  return base64EncryptionKey;
}

// missing value (in dev) allowed: mails written to log, moderation panel stays locked
export function requireUnlessDevelopment(key: string, nodeEnv: string): string | null {
  const value = process.env[key];
  if (!value && nodeEnv !== "DEVELOPMENT"){
    failEnv(`${key} is undefined! Please define in the .env file.`);
  }
  return value || null;
}

// one password for everyone who moderates and panel is reachable from internet -> must be long
const MIN_MODERATION_PASSWORD_LENGTH = 24;

export function requireModerationPassword(nodeEnv: string): string | null {
  const password = requireUnlessDevelopment("MODERATION_PASSWORD", nodeEnv);
  if (password !== null && nodeEnv !== "DEVELOPMENT" && password.length < MIN_MODERATION_PASSWORD_LENGTH) {
    failEnv(`MODERATION_PASSWORD must have at least ${MIN_MODERATION_PASSWORD_LENGTH} characters, e.g. from \`openssl rand -base64 32\`.`);
  }
  return password;
}

export function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl){
    failEnv("DATABASE_URL is undefined! Please define in the .env file.");
  }
  return databaseUrl;
}

function buildEnvConfig(): EnvConfig {
  const nodeEnv = requireNodeEnv() as "DEVELOPMENT" | "PRODUCTION";

  return {
    nodeEnv,
    sessionSecret: requireSessionSecret(),
    databaseUrl: requireDatabaseUrl(),
    proxyHop: Number(requireProxyHop()),
    cacheEnabled: nodeEnv === "DEVELOPMENT" ? requireCacheEnabled() === "true" : false,
    encryptionKey: requireBase64Key("ENCRYPTION_KEY"),
    encryptionKeySecondary: requireBase64Key("ENCRYPTION_KEY_SECONDARY"),
    encryptionKeyLookup: requireBase64Key("ENCRYPTION_KEY_LOOKUP"),
    brevoApiKey: requireUnlessDevelopment("BREVO_API_KEY", nodeEnv),
    moderationPassword: requireModerationPassword(nodeEnv)
  };
}

export const envConfig: EnvConfig = buildEnvConfig();