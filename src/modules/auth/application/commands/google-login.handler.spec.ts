import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { CredentialProvider } from '@prisma/client';
import { GoogleLoginHandler } from './google-login.handler.js';
import { GoogleLoginCommand } from './google-login.command.js';
import { AuthErrorCodes, UserErrorCodes } from '@/core/index.js';
import {
  UserDomainException,
  type IUserRepository,
} from '../../../users/domain/index.js';
import type {
  GoogleIdentity,
  ICredentialRepository,
} from '../../domain/index.js';
import type { AccountMailer } from '../services/account-mailer.service.js';
import type { GoogleIdentityService } from '../services/google-identity.service.js';
import type { SessionIssuer } from '../services/session-issuer.service.js';

const CLIENT = { ip: '203.0.113.7', userAgent: 'Chrome' };
const TOKENS = { accessToken: 'at', refreshToken: 'rt' };
const IDENTITY: GoogleIdentity = {
  sub: 'google-sub-1',
  email: 'jane@example.com',
  emailVerified: true,
  name: 'Jane Doe',
  picture: 'https://lh3.googleusercontent.com/a/photo',
  expiresAt: new Date(Date.now() + 3600_000),
  tokenId: 'token-id-1',
};
const login = () => new GoogleLoginCommand('id-token', 'nonce-1', CLIENT);
const existingUser = (
  credentials: Array<{ provider: CredentialProvider; identifier: string }> = [],
) => ({
  id: 'user-1',
  role: 'CUSTOMER',
  credentials,
});

describe('GoogleLoginHandler', () => {
  let handler: GoogleLoginHandler;
  let userRepo: {
    findByCredential: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
  let credentialRepo: {
    linkGoogle: ReturnType<typeof vi.fn>;
    fillProfileIfEmpty: ReturnType<typeof vi.fn>;
  };
  let identities: {
    authenticate: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  let logged: string[];
  let sessionIssuer: { start: ReturnType<typeof vi.fn> };
  let mailer: { sendGoogleLinked: ReturnType<typeof vi.fn> };

  const code = (promise: Promise<unknown>) =>
    promise.then(
      () => 'resolved',
      (e: any) => e.code ?? e.constructor.name,
    );

  /** findByCredential answers by provider: [byGoogle, byEmail] (a list means "one answer per call") */
  const accounts = (byGoogle: unknown, byEmail: unknown) =>
    userRepo.findByCredential.mockImplementation(
      async (provider: CredentialProvider) => {
        const answer =
          provider === CredentialProvider.GOOGLE ? byGoogle : byEmail;
        return Array.isArray(answer) ? (answer.shift() ?? null) : answer;
      },
    );

  beforeEach(() => {
    userRepo = {
      findByCredential: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
    };
    credentialRepo = {
      linkGoogle: vi.fn().mockResolvedValue('LINKED'),
      fillProfileIfEmpty: vi.fn().mockResolvedValue(undefined),
    };
    logged = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
      logged.push(String(m));
    });
    identities = {
      authenticate: vi.fn().mockResolvedValue(IDENTITY),
      release: vi.fn().mockResolvedValue(undefined),
    };
    sessionIssuer = { start: vi.fn().mockResolvedValue(TOKENS) };
    mailer = { sendGoogleLinked: vi.fn().mockResolvedValue(undefined) };

    handler = new GoogleLoginHandler(
      userRepo as unknown as IUserRepository,
      credentialRepo as unknown as ICredentialRepository,
      identities as unknown as GoogleIdentityService,
      sessionIssuer as unknown as SessionIssuer,
      mailer as unknown as AccountMailer,
    );
  });

  it('checks the token (with the nonce) before anything else', async () => {
    await handler.execute(login());

    expect(identities.authenticate).toHaveBeenCalledWith('id-token', 'nonce-1');
  });

  describe('a person with no account yet (AC-1)', () => {
    it('creates an account with a Google credential and an email credential without a password, and says it is new', async () => {
      const result = await handler.execute(login());

      expect(result).toEqual({ ...TOKENS, isNewUser: true });
      const created = userRepo.save.mock.calls[0][0];
      expect(created.role).toBe('CUSTOMER');
      expect(
        created.credentials.map((c: any) => [
          c.provider,
          c.identifier,
          c.secret,
        ]),
      ).toEqual([
        [CredentialProvider.GOOGLE, 'google-sub-1', null],
        [CredentialProvider.EMAIL, 'jane@example.com', null],
      ]);
      expect(sessionIssuer.start).toHaveBeenCalledWith(created, CLIENT);
    });

    it('takes the display name and picture from Google, to be edited later', async () => {
      await handler.execute(login());

      const created = userRepo.save.mock.calls[0][0];
      expect(created.displayName).toBe('Jane Doe');
      expect(created.avatarUrl).toBe(
        'https://lh3.googleusercontent.com/a/photo',
      );
    });

    it('cuts a very long name, drops a blank one, and ignores a picture that is not https', async () => {
      identities.authenticate.mockResolvedValue({
        ...IDENTITY,
        name: 'x'.repeat(400),
        picture: 'http://insecure.example.com/p.png',
      });
      await handler.execute(login());
      let created = userRepo.save.mock.calls[0][0];
      expect(created.displayName).toHaveLength(255);
      expect(created.avatarUrl).toBeNull();

      identities.authenticate.mockResolvedValue({ ...IDENTITY, name: '   ' });
      await handler.execute(login());
      created = userRepo.save.mock.calls[1][0];
      expect(created.displayName).toBeNull();
    });

    it('sends no email: nothing was linked to anybody', async () => {
      await handler.execute(login());

      expect(mailer.sendGoogleLinked).not.toHaveBeenCalled();
    });
  });

  describe('a Google account that is already linked (AC-2)', () => {
    it('logs in to that account, whatever email the token carries now, and creates nothing', async () => {
      accounts(existingUser(), null);

      const result = await handler.execute(login());

      expect(result).toEqual({ ...TOKENS, isNewUser: false });
      expect(userRepo.save).not.toHaveBeenCalled();
      expect(credentialRepo.linkGoogle).not.toHaveBeenCalled();
      expect(credentialRepo.fillProfileIfEmpty).not.toHaveBeenCalled();
      // the email lookup is never needed
      expect(userRepo.findByCredential).toHaveBeenCalledTimes(1);
    });
  });

  describe('an account with the same email (AC-3)', () => {
    const withPassword = existingUser([
      { provider: CredentialProvider.EMAIL, identifier: 'jane@example.com' },
    ]);

    it('links Google to it, logs in to it, and is not new', async () => {
      accounts(null, withPassword);

      const result = await handler.execute(login());

      expect(result).toEqual({ ...TOKENS, isNewUser: false });
      expect(credentialRepo.linkGoogle).toHaveBeenCalledWith(
        'user-1',
        'google-sub-1',
      );
      expect(userRepo.save).not.toHaveBeenCalled();
      expect(sessionIssuer.start).toHaveBeenCalledWith(withPassword, CLIENT);
    });

    it('tells the owner by email', async () => {
      accounts(null, withPassword);

      await handler.execute(login());

      expect(mailer.sendGoogleLinked).toHaveBeenCalledWith('jane@example.com');
    });

    it('fills the name and picture only where the account has none, never overwriting', async () => {
      accounts(null, withPassword);

      await handler.execute(login());

      expect(credentialRepo.fillProfileIfEmpty).toHaveBeenCalledWith('user-1', {
        displayName: 'Jane Doe',
        avatarUrl: 'https://lh3.googleusercontent.com/a/photo',
      });
    });

    it('still logs in, and has already told the owner, when filling in the profile fails', async () => {
      accounts(null, withPassword);
      credentialRepo.fillProfileIfEmpty.mockRejectedValue(new Error('db blip'));

      const result = await handler.execute(login());

      expect(result.isNewUser).toBe(false);
      expect(mailer.sendGoogleLinked).toHaveBeenCalledOnce();
      expect(logged.join('\n')).toContain('Could not fill in the profile');
    });

    it('refuses when that account already has a DIFFERENT Google account: an address changing hands must not hand over the account (AC-8)', async () => {
      accounts(
        null,
        existingUser([
          {
            provider: CredentialProvider.EMAIL,
            identifier: 'jane@example.com',
          },
          {
            provider: CredentialProvider.GOOGLE,
            identifier: 'someone-elses-sub',
          },
        ]),
      );

      expect(await code(handler.execute(login()))).toBe(
        AuthErrorCodes.GOOGLE_ACCOUNT_CONFLICT.code,
      );
      expect(credentialRepo.linkGoogle).not.toHaveBeenCalled();
      expect(sessionIssuer.start).not.toHaveBeenCalled();
    });
  });

  describe('two first sign-ins at the same moment (AC-9)', () => {
    it('finds the account the other request just made, instead of failing, when saving hits the unique email', async () => {
      const winner = existingUser();
      // first pass: nothing; second pass (after the clash): the account exists under this Google id
      accounts([null, winner], null);
      userRepo.save.mockRejectedValueOnce(
        new UserDomainException(UserErrorCodes.EMAIL_ALREADY_EXISTS),
      );

      const result = await handler.execute(login());

      expect(result).toEqual({ ...TOKENS, isNewUser: false });
      expect(sessionIssuer.start).toHaveBeenCalledWith(winner, CLIENT);
    });

    it('looks again once when somebody linked this Google account a moment ago, then logs in to it', async () => {
      const winner = existingUser();
      accounts(
        [null, winner],
        existingUser([
          {
            provider: CredentialProvider.EMAIL,
            identifier: 'jane@example.com',
          },
        ]),
      );
      credentialRepo.linkGoogle.mockResolvedValueOnce('SUB_TAKEN');

      const result = await handler.execute(login());

      expect(result.isNewUser).toBe(false);
      expect(sessionIssuer.start).toHaveBeenCalledWith(winner, CLIENT);
    });

    it('gives up with a conflict, not a loop, when it still cannot settle after one more look', async () => {
      accounts(
        null,
        existingUser([
          {
            provider: CredentialProvider.EMAIL,
            identifier: 'jane@example.com',
          },
        ]),
      );
      credentialRepo.linkGoogle.mockResolvedValue('SUB_TAKEN');

      expect(await code(handler.execute(login()))).toBe(
        AuthErrorCodes.GOOGLE_ACCOUNT_CONFLICT.code,
      );
      expect(credentialRepo.linkGoogle).toHaveBeenCalledTimes(2);
    });

    it('lets any other saving error through unchanged', async () => {
      userRepo.save.mockRejectedValue(new Error('db down'));

      await expect(handler.execute(login())).rejects.toThrow('db down');
    });
  });

  describe('giving the token back', () => {
    it('releases the token when the database fails after it was used up, so the same token can be tried again', async () => {
      userRepo.save.mockRejectedValue(new ServiceUnavailableException());

      await expect(handler.execute(login())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      expect(identities.release).toHaveBeenCalledWith(IDENTITY);
    });

    it('releases it when starting the session fails', async () => {
      sessionIssuer.start.mockRejectedValue(new Error('redis down'));

      await expect(handler.execute(login())).rejects.toThrow('redis down');

      expect(identities.release).toHaveBeenCalledWith(IDENTITY);
    });

    it('keeps the token used when the refusal is about the account (a conflict)', async () => {
      accounts(
        null,
        existingUser([
          {
            provider: CredentialProvider.EMAIL,
            identifier: 'jane@example.com',
          },
          {
            provider: CredentialProvider.GOOGLE,
            identifier: 'someone-elses-sub',
          },
        ]),
      );

      await expect(handler.execute(login())).rejects.toBeDefined();

      expect(identities.release).not.toHaveBeenCalled();
    });

    it('does not release anything after a success', async () => {
      await handler.execute(login());

      expect(identities.release).not.toHaveBeenCalled();
    });
  });

  it('creates no session when the token is refused (AC-5)', async () => {
    identities.authenticate.mockRejectedValue(new Error('refused'));

    await expect(handler.execute(login())).rejects.toThrow('refused');

    expect(userRepo.findByCredential).not.toHaveBeenCalled();
    expect(sessionIssuer.start).not.toHaveBeenCalled();
  });
});
