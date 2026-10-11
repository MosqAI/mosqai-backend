import { z } from 'zod';

const duration = z
  .string()
  .regex(/^\d+[smhd]$/, 'use a number followed by s, m, h or d, e.g. 15m')
  .transform((v) => {
    const n = Number(v.slice(0, -1));
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[
      v.at(-1) as 's' | 'm' | 'h' | 'd'
    ];
    return n * unit;
  });

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  /** Postgres pool size. The embedded `prisma dev` server needs 1. */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** Comma-separated browser origins allowed to call the API. */
  CORS_ORIGINS: z.string().default('http://localhost:3001'),

  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: duration.default(15 * 60),
  JWT_REFRESH_TTL: duration.default(30 * 86400),

  /** Empty disables MQTT (e.g. API-only tests). */
  MQTT_URL: z.string().default(''),
  MQTT_USERNAME: z.string().optional(),
  MQTT_PASSWORD: z.string().optional(),
  /** e.g. smtps://user:pass@smtp.example.com:465. Empty: emails are saved to .outbox/ instead. */
  SMTP_URL: z.string().default(''),
  MAIL_FROM: z.string().default('MosqAI Shield <no-reply@mosqai.rw>'),
  /** Authority dashboard address, used in links inside emails. */
  WEB_APP_URL: z.url().default('http://localhost:3100'),
  DEVICE_HEARTBEAT_TIMEOUT_S: z.coerce.number().int().positive().default(90),
  COMMAND_ACK_TIMEOUT_S: z.coerce.number().int().positive().default(30),
});

/** Durations are parsed to seconds. */
export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(
      `Invalid environment variables:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export const ENV = Symbol('ENV');
