import { registerAs, type ConfigType } from '@nestjs/config';

/** Settings about the application itself, parsed once at boot. */
export const appConfig = registerAs('app', () => ({
  /** The shop's name, shown in emails. */
  name: process.env.APP_NAME?.trim() || 'Ecom',
}));

export type AppConfig = ConfigType<typeof appConfig>;
