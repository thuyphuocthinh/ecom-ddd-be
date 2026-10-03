import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { CredentialProvider } from '@prisma/client';
import { LinkGoogleHandler } from './link-google.handler.js';
import { LinkGoogleCommand } from './link-google.command.js';
import { UnlinkGoogleHandler } from './unlink-google.handler.js';
import { UnlinkGoogleCommand } from './unlink-google.command.js';
import { AuthErrorCodes } from '@/core/index.js';
import { HashUtil } from '@/core/utils/hash.util.js';
import type { IUserRepository } from '../../../users/domain/index.js';
import type {
  GoogleIdentity,
  ICredentialRepository,
} from '../../domain/index.js';
import type { AccountMailer } from '../services/account-mailer.service.js';
import type { GoogleIdentityService } from '../services/google-identity.service.js';

const IDENTITY: GoogleIdentity = {
  sub: 'google-sub-1',
  email: 'other-address@example.com',
  emailVerified: true,
  name: 'Jane',
  expiresAt: new Date(Date.now() + 3600_000),
  tokenId: 'token-id-1',
};
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (e: any) => e.code ?? e.constructor.name,
  );

const passwordUser = (
  extra: Array<{ provider: CredentialProvider; identifier: string }> = [],
) => ({
  id: 'user-1',
  credentials: [
    {
      provider: CredentialProvider.EMAIL,
      identifier: 'jane@example.com',
      secret: '$argon2id$hash',
    },
    ...extra,
  ],
});

describe('LinkGoogleHandler', () => {
  let handler: LinkGoogleHandler;
  let calls: string[];
  let userRepo: { findById: ReturnType<typeof vi.fn> };
  let credentialRepo: {
    linkGoogle: ReturnType<typeof vi.fn>;
    fillProfileIfEmpty: ReturnType<typeof vi.fn>;
  };
  let identities: {
    authenticate: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  };
  let mailer: { sendGoogleLinked: ReturnType<typeof vi.fn> };
  let logged: string[];
  const link = (password: string | null = 'Right-Password-1!') =>
    new LinkGoogleCommand('user-1', 'id-token', 'n-1', password ?? undefined);

  beforeEach(() => {
    vi.restoreAllMocks();
    logged = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
      logged.push(String(m));
    });
    calls = [];
    vi.spyOn(HashUtil, 'comparePassword').mockImplementation(
      async (plain: string) => plain === 'Right-Password-1!',
    );
    userRepo = { findById: vi.fn().mockResolvedValue(passwordUser()) };
    credentialRepo = {
      linkGoogle: vi.fn().mockImplementation(async () => {
        calls.push('link');
        return 'LINKED';
      }),
      fillProfileIfEmpty: vi.fn().mockImplementation(async () => {
        calls.push('fill profile');
      }),
    };
    identities = {
      authenticate: vi.fn().mockImplementation(async () => {
        calls.push('use token');
        return IDENTITY;
      }),
      release: vi.fn().mockResolvedValue(undefined),
    };
    mailer = {
      sendGoogleLinked: vi.fn().mockImplementation(async () => {
        calls.push('notify owner');
      }),
    };
    handler = new LinkGoogleHandler(
      userRepo as unknown as IUserRepository,
      credentialRepo as unknown as ICredentialRepository,
      identities as unknown as GoogleIdentityService,
      mailer as unknown as AccountMailer,
    );
  });

  it('links the Google account to the logged-in user, even when its email differs from the account email (AC-10)', async () => {
    await handler.execute(link());

    expect(identities.authenticate).toHaveBeenCalledWith('id-token', 'n-1');
    expect(credentialRepo.linkGoogle).toHaveBeenCalledWith(
      'user-1',
      'google-sub-1',
    );
  });

  describe('proving it is the owner', () => {
    it('needs the current password when the account has one, and checks it BEFORE the Google token is used up', async () => {
      await handler.execute(link());

      expect(calls.indexOf('use token')).toBeGreaterThan(-1);
      expect(HashUtil.comparePassword).toHaveBeenCalledWith(
        'Right-Password-1!',
        '$argon2id$hash',
      );
    });

    it.each([null, '', 'Wrong-Password-1!'])(
      'refuses %j with AUTH-012 and neither uses the token nor links anything',
      async (password) => {
        expect(await code(handler.execute(link(password)))).toBe(
          AuthErrorCodes.INCORRECT_CURRENT_PASSWORD.code,
        );

        expect(identities.authenticate).not.toHaveBeenCalled();
        expect(credentialRepo.linkGoogle).not.toHaveBeenCalled();
        expect(mailer.sendGoogleLinked).not.toHaveBeenCalled();
      },
    );

    it('does not ask for a password from an account that has none', async () => {
      userRepo.findById.mockResolvedValue({
        id: 'user-1',
        credentials: [
          {
            provider: CredentialProvider.EMAIL,
            identifier: 'jane@example.com',
            secret: null,
          },
        ],
      });

      await expect(handler.execute(link(null))).resolves.toBeUndefined();
    });
  });

  it('tells the owner at the ACCOUNT email, not the Google one, as soon as the link exists (AC-3)', async () => {
    await handler.execute(link());

    expect(mailer.sendGoogleLinked).toHaveBeenCalledWith('jane@example.com');
    expect(calls).toEqual([
      'use token',
      'link',
      'notify owner',
      'fill profile',
    ]);
  });

  it('fills the name and picture only where empty', async () => {
    await handler.execute(link());

    expect(credentialRepo.fillProfileIfEmpty).toHaveBeenCalledWith('user-1', {
      displayName: 'Jane',
      avatarUrl: null,
    });
  });

  it('still succeeds, and has already told the owner, when filling in the profile fails', async () => {
    credentialRepo.fillProfileIfEmpty.mockRejectedValue(new Error('db blip'));

    await expect(handler.execute(link())).resolves.toBeUndefined();

    expect(mailer.sendGoogleLinked).toHaveBeenCalledOnce();
    expect(logged.join('\n')).toContain('Could not fill in the profile');
  });

  it('does nothing, sends nothing and succeeds when this very Google account is already linked (AC-10)', async () => {
    userRepo.findById.mockResolvedValue(
      passwordUser([
        { provider: CredentialProvider.GOOGLE, identifier: 'google-sub-1' },
      ]),
    );

    await expect(handler.execute(link())).resolves.toBeUndefined();

    expect(credentialRepo.linkGoogle).not.toHaveBeenCalled();
    expect(mailer.sendGoogleLinked).not.toHaveBeenCalled();
  });

  it('refuses a different Google account when the user already has one linked (AC-10)', async () => {
    userRepo.findById.mockResolvedValue(
      passwordUser([
        { provider: CredentialProvider.GOOGLE, identifier: 'another-sub' },
      ]),
    );

    expect(await code(handler.execute(link()))).toBe('AUTH-016');
    expect(credentialRepo.linkGoogle).not.toHaveBeenCalled();
  });

  it('answers 409 when the Google account belongs to somebody else (AC-10)', async () => {
    credentialRepo.linkGoogle.mockResolvedValue('SUB_TAKEN');

    expect(await code(handler.execute(link()))).toBe('AUTH-016');
    expect(mailer.sendGoogleLinked).not.toHaveBeenCalled();
  });

  describe('two requests at the same moment', () => {
    it('succeeds when the other request linked this very Google account (it is the same result)', async () => {
      credentialRepo.linkGoogle.mockResolvedValue('USER_HAS_GOOGLE');
      userRepo.findById
        .mockResolvedValueOnce(passwordUser())
        .mockResolvedValueOnce(
          passwordUser([
            { provider: CredentialProvider.GOOGLE, identifier: 'google-sub-1' },
          ]),
        );

      await expect(handler.execute(link())).resolves.toBeUndefined();
      expect(mailer.sendGoogleLinked).not.toHaveBeenCalled();
    });

    it('answers 409 when the other request linked a different Google account', async () => {
      credentialRepo.linkGoogle.mockResolvedValue('USER_HAS_GOOGLE');
      userRepo.findById
        .mockResolvedValueOnce(passwordUser())
        .mockResolvedValueOnce(
          passwordUser([
            { provider: CredentialProvider.GOOGLE, identifier: 'someone-else' },
          ]),
        );

      expect(await code(handler.execute(link()))).toBe('AUTH-016');
    });
  });

  describe('giving the token back', () => {
    it('releases it when the database fails after it was used up, so the same token can be tried again', async () => {
      credentialRepo.linkGoogle.mockRejectedValue(
        new ServiceUnavailableException(),
      );

      await expect(handler.execute(link())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );

      expect(identities.release).toHaveBeenCalledWith(IDENTITY);
    });

    it('keeps it used when the refusal is about the account (a conflict)', async () => {
      credentialRepo.linkGoogle.mockResolvedValue('SUB_TAKEN');

      await expect(handler.execute(link())).rejects.toBeDefined();

      expect(identities.release).not.toHaveBeenCalled();
    });
  });

  it('refuses a bad token before touching anything', async () => {
    identities.authenticate.mockRejectedValue(new Error('refused'));

    await expect(handler.execute(link())).rejects.toThrow('refused');

    expect(credentialRepo.linkGoogle).not.toHaveBeenCalled();
  });

  it('answers 401, not a misleading Google conflict, when the user no longer exists', async () => {
    userRepo.findById.mockResolvedValue(null);

    expect(await code(handler.execute(link()))).toBe(
      AuthErrorCodes.INVALID_CREDENTIALS.code,
    );
    expect(identities.authenticate).not.toHaveBeenCalled();
  });
});

describe('UnlinkGoogleHandler', () => {
  let handler: UnlinkGoogleHandler;
  let credentialRepo: { unlinkGoogle: ReturnType<typeof vi.fn> };
  const unlink = () => new UnlinkGoogleCommand('user-1');

  beforeEach(() => {
    credentialRepo = { unlinkGoogle: vi.fn().mockResolvedValue('UNLINKED') };
    handler = new UnlinkGoogleHandler(
      credentialRepo as unknown as ICredentialRepository,
    );
  });

  it('removes the link for the logged-in user (AC-11)', async () => {
    await expect(handler.execute(unlink())).resolves.toBeUndefined();

    expect(credentialRepo.unlinkGoogle).toHaveBeenCalledWith('user-1');
  });

  it('refuses with 400 when Google is the only way in (AC-11)', async () => {
    credentialRepo.unlinkGoogle.mockResolvedValue('LAST_METHOD');

    expect(await code(handler.execute(unlink()))).toBe(
      AuthErrorCodes.LAST_LOGIN_METHOD.code,
    );
  });

  it('answers 404 when nothing is linked (AC-11)', async () => {
    credentialRepo.unlinkGoogle.mockResolvedValue('NOT_LINKED');

    expect(await code(handler.execute(unlink()))).toBe(
      AuthErrorCodes.GOOGLE_NOT_LINKED.code,
    );
  });
});
