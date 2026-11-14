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
  resendApiKey: string | null;
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

// in development a missing value is allowed: mails are written to the log, the moderation panel stays locked
export function requireUnlessDevelopment(key: string, nodeEnv: string): string | null {
  const value = process.env[key];
  if (!value && nodeEnv !== "DEVELOPMENT"){
    failEnv(`${key} is undefined! Please define in the .env file.`);
  }
  return value || null;
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
    resendApiKey: requireUnlessDevelopment("RESEND_API_KEY", nodeEnv),
    moderationPassword: requireUnlessDevelopment("MODERATION_PASSWORD", nodeEnv)
  };
}

export const envConfig: EnvConfig = buildEnvConfig();