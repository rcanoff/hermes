import { z } from "zod";

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  MCP_BEARER_TOKEN: z.string().min(1),
  APPLE_CALDAV_URL: z.string().url(),
  APPLE_CALDAV_USERNAME: z.string().min(1),
  APPLE_CALDAV_APP_PASSWORD: z.string().min(1)
});

export type AppConfig = {
  port: number;
  mcpBearerToken: string;
  caldavUrl: string;
  caldavUsername: string;
  caldavPassword: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.parse(env);
  return {
    port: parsed.PORT,
    mcpBearerToken: parsed.MCP_BEARER_TOKEN,
    caldavUrl: parsed.APPLE_CALDAV_URL,
    caldavUsername: parsed.APPLE_CALDAV_USERNAME,
    caldavPassword: parsed.APPLE_CALDAV_APP_PASSWORD
  };
}
