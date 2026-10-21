function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8080),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: required('DATABASE_URL', 'postgres://syncanvas:syncanvas@localhost:5432/syncanvas'),
  redisUrl: required('REDIS_URL', 'redis://localhost:6379'),
  jwtSecret: required('JWT_SECRET', 'dev-only-secret'),
  jwtTtlSeconds: Number(process.env.JWT_TTL_SECONDS ?? 86400),
} as const;
