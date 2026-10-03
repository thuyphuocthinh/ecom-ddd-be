import { describe, it, expect } from 'vitest';
import { validateEnv } from './env.validation.js';

const VALID = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

describe('validateEnv', () => {
  it('passes through a valid config unchanged', () => {
    const config = { ...VALID, PORT: '3000' };
    expect(validateEnv(config)).toBe(config);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() =>
      validateEnv({ JWT_ACCESS_SECRET: VALID.JWT_ACCESS_SECRET }),
    ).toThrow(/DATABASE_URL/);
  });

  it('throws when DATABASE_URL is not a postgres connection string', () => {
    expect(() =>
      validateEnv({ ...VALID, DATABASE_URL: 'mysql://user:pass@localhost/db' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('throws when PORT is not a valid port number', () => {
    expect(() => validateEnv({ ...VALID, PORT: 'not-a-number' })).toThrow(
      /PORT/,
    );
  });

  describe('EMAIL_PROVIDER', () => {
    it('defaults to the log adapter outside production', () => {
      expect(() => validateEnv({ ...VALID })).not.toThrow();
      expect(() =>
        validateEnv({ ...VALID, NODE_ENV: 'development' }),
      ).not.toThrow();
    });

    it('rejects an unknown provider', () => {
      expect(() =>
        validateEnv({ ...VALID, EMAIL_PROVIDER: 'carrier-pigeon' }),
      ).toThrow(/EMAIL_PROVIDER/);
    });

    it('refuses the log adapter in production, whether chosen or defaulted (it prints one-time codes)', () => {
      expect(() =>
        validateEnv({
          ...VALID,
          NODE_ENV: 'production',
          EMAIL_PROVIDER: 'log',
        }),
      ).toThrow(/EMAIL_PROVIDER=log/);
      expect(() => validateEnv({ ...VALID, NODE_ENV: 'production' })).toThrow(
        /EMAIL_PROVIDER=log/,
      );
    });
  });

  describe('EMAIL_PROVIDER=smtp', () => {
    const SMTP = {
      ...VALID,
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      EMAIL_FROM: 'Ecom <no-reply@example.com>',
    };

    it('accepts the minimal settings: a host and a sender address', () => {
      expect(() => validateEnv(SMTP)).not.toThrow();
    });

    it('accepts a full config with port, TLS flag and login', () => {
      expect(() =>
        validateEnv({
          ...SMTP,
          SMTP_PORT: '465',
          SMTP_SECURE: 'true',
          SMTP_USER: 'apikey',
          SMTP_PASS: 'secret',
        }),
      ).not.toThrow();
    });

    it('is allowed in production, unlike the log adapter', () => {
      expect(() =>
        validateEnv({
          ...SMTP,
          NODE_ENV: 'production',
          RABBITMQ_URL: 'amqp://u:p@broker:5672',
        }),
      ).not.toThrow();
    });

    it('needs a host', () => {
      expect(() => validateEnv({ ...SMTP, SMTP_HOST: undefined })).toThrow(
        /SMTP_HOST/,
      );
      expect(() => validateEnv({ ...SMTP, SMTP_HOST: '  ' })).toThrow(
        /SMTP_HOST/,
      );
    });

    it('needs a sender address', () => {
      expect(() => validateEnv({ ...SMTP, EMAIL_FROM: undefined })).toThrow(
        /EMAIL_FROM/,
      );
      expect(() =>
        validateEnv({ ...SMTP, EMAIL_FROM: 'not-an-address' }),
      ).toThrow(/EMAIL_FROM/);
    });

    it('rejects a port that is not a valid port number', () => {
      expect(() => validateEnv({ ...SMTP, SMTP_PORT: 'abc' })).toThrow(
        /SMTP_PORT/,
      );
      expect(() => validateEnv({ ...SMTP, SMTP_PORT: '70000' })).toThrow(
        /SMTP_PORT/,
      );
    });

    it('rejects an SMTP_SECURE that is not true or false', () => {
      expect(() => validateEnv({ ...SMTP, SMTP_SECURE: 'yes' })).toThrow(
        /SMTP_SECURE/,
      );
    });

    it('wants the login as a pair: a user without a password cannot work', () => {
      expect(() => validateEnv({ ...SMTP, SMTP_USER: 'apikey' })).toThrow(
        /SMTP_USER and SMTP_PASS/,
      );
      expect(() => validateEnv({ ...SMTP, SMTP_PASS: 'secret' })).toThrow(
        /SMTP_USER and SMTP_PASS/,
      );
    });

    it('is not checked when another provider is chosen', () => {
      expect(() =>
        validateEnv({ ...VALID, EMAIL_PROVIDER: 'log' }),
      ).not.toThrow();
    });
  });

  describe('JOB_QUEUE', () => {
    it('defaults to rabbitmq and accepts rabbitmq or inline', () => {
      expect(() => validateEnv({ ...VALID })).not.toThrow();
      expect(() =>
        validateEnv({ ...VALID, JOB_QUEUE: 'rabbitmq' }),
      ).not.toThrow();
      expect(() =>
        validateEnv({ ...VALID, JOB_QUEUE: 'inline' }),
      ).not.toThrow();
    });

    it('rejects any other value with a clear message (AC-13)', () => {
      expect(() => validateEnv({ ...VALID, JOB_QUEUE: 'kafka' })).toThrow(
        /JOB_QUEUE must be one of: rabbitmq, inline \(got "kafka"\)/,
      );
    });

    it('requires RABBITMQ_URL in production when the queue is rabbitmq, so the local default login is never used (AC-13)', () => {
      const production = {
        ...VALID,
        NODE_ENV: 'production',
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        EMAIL_FROM: 'no-reply@example.com',
      };

      expect(() => validateEnv(production)).toThrow(/RABBITMQ_URL/);
      expect(() =>
        validateEnv({ ...production, RABBITMQ_URL: 'amqp://u:p@broker:5672' }),
      ).not.toThrow();
    });

    it.each(['staging', 'prod', 'Production'])(
      'treats NODE_ENV=%s as not local: the default development login is never used there (AC-13)',
      (NODE_ENV) => {
        expect(() =>
          validateEnv({
            ...VALID,
            NODE_ENV,
            EMAIL_PROVIDER: 'smtp',
            SMTP_HOST: 'smtp.example.com',
            EMAIL_FROM: 'no-reply@example.com',
          }),
        ).toThrow(/RABBITMQ_URL/);
      },
    );

    it('refuses the inline queue in production: it would make forgot-password slower for an address with an account (AC-2)', () => {
      expect(() =>
        validateEnv({
          ...VALID,
          NODE_ENV: 'production',
          JOB_QUEUE: 'inline',
          EMAIL_PROVIDER: 'smtp',
          SMTP_HOST: 'smtp.example.com',
          EMAIL_FROM: 'no-reply@example.com',
        }),
      ).toThrow(/JOB_QUEUE=inline/);
    });

    it('does not accept a blank RABBITMQ_URL where one is required', () => {
      expect(() =>
        validateEnv({
          ...VALID,
          NODE_ENV: 'staging',
          RABBITMQ_URL: '   ',
          EMAIL_PROVIDER: 'smtp',
          SMTP_HOST: 'smtp.example.com',
          EMAIL_FROM: 'no-reply@example.com',
        }),
      ).toThrow(/RABBITMQ_URL/);
    });

    it('does not need RABBITMQ_URL in development or with the inline queue (outside production)', () => {
      expect(() =>
        validateEnv({ ...VALID, NODE_ENV: 'development' }),
      ).not.toThrow();
      expect(() =>
        validateEnv({
          ...VALID,
          NODE_ENV: 'staging',
          JOB_QUEUE: 'inline',
          EMAIL_PROVIDER: 'smtp',
          SMTP_HOST: 'smtp.example.com',
          EMAIL_FROM: 'no-reply@example.com',
        }),
      ).not.toThrow();
    });
  });

  describe('GOOGLE_CLIENT_IDS', () => {
    it('is optional: without it sign in with Google is simply off', () => {
      expect(() => validateEnv({ ...VALID })).not.toThrow();
      expect(() =>
        validateEnv({ ...VALID, GOOGLE_CLIENT_IDS: '' }),
      ).not.toThrow();
    });

    it('accepts one or several Google client ids (web, Android, iOS)', () => {
      expect(() =>
        validateEnv({
          ...VALID,
          GOOGLE_CLIENT_IDS: '123-abc.apps.googleusercontent.com',
        }),
      ).not.toThrow();
      expect(() =>
        validateEnv({
          ...VALID,
          GOOGLE_CLIENT_IDS:
            '123-abc.apps.googleusercontent.com, 456-def.apps.googleusercontent.com',
        }),
      ).not.toThrow();
    });

    it.each([
      'not-an-id',
      'abc.example.com',
      '123-abc.apps.googleusercontent.com,oops',
    ])(
      'rejects "%s" with a message that says no client secret is needed',
      (GOOGLE_CLIENT_IDS) => {
        expect(() => validateEnv({ ...VALID, GOOGLE_CLIENT_IDS })).toThrow(
          /GOOGLE_CLIENT_IDS.*client secret is not needed/,
        );
      },
    );
  });

  describe('JWT settings', () => {
    it('throws when JWT_ACCESS_SECRET is missing', () => {
      expect(() => validateEnv({ DATABASE_URL: VALID.DATABASE_URL })).toThrow(
        /JWT_ACCESS_SECRET/,
      );
    });

    it('throws when JWT_ACCESS_SECRET is shorter than 32 characters', () => {
      expect(() =>
        validateEnv({ ...VALID, JWT_ACCESS_SECRET: 'x'.repeat(31) }),
      ).toThrow(/JWT_ACCESS_SECRET/);
    });

    it.each([
      'JWT_ACCESS_TTL_SECONDS',
      'REFRESH_TOKEN_TTL_SECONDS',
      'SESSION_ABSOLUTE_TTL_SECONDS',
    ])('throws when %s is not a positive integer', (name) => {
      expect(() => validateEnv({ ...VALID, [name]: 'abc' })).toThrow(
        new RegExp(name),
      );
      expect(() => validateEnv({ ...VALID, [name]: '0' })).toThrow(
        new RegExp(name),
      );
      expect(() => validateEnv({ ...VALID, [name]: '-5' })).toThrow(
        new RegExp(name),
      );
    });

    it('accepts the TTL variables when they are positive integers (env values are strings)', () => {
      expect(() =>
        validateEnv({
          ...VALID,
          JWT_ACCESS_TTL_SECONDS: '900',
          REFRESH_TOKEN_TTL_SECONDS: '604800',
          SESSION_ABSOLUTE_TTL_SECONDS: '2592000',
        }),
      ).not.toThrow();
    });
  });
});
