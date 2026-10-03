import { describe, it, expect } from 'vitest';
import { CredentialProvider } from '@prisma/client';
import { User } from './user.entity.js';

const userWith = (
  ...credentials: Array<[CredentialProvider, string, string | null]>
) => {
  const user = User.create('u-1');
  credentials.forEach(([provider, identifier, secret], index) =>
    user.addCredential(`c-${index}`, provider, identifier, secret),
  );
  return user;
};

describe('User sign-in methods', () => {
  it('an email and password account', () => {
    const user = userWith([
      CredentialProvider.EMAIL,
      'jane@example.com',
      'hash',
    ]);

    expect(user.email).toBe('jane@example.com');
    expect(user.hasPassword).toBe(true);
    expect(user.googleLinked).toBe(false);
  });

  it('a Google-only account has an email but no password', () => {
    const user = userWith(
      [CredentialProvider.EMAIL, 'jane@example.com', null],
      [CredentialProvider.GOOGLE, 'google-sub', null],
    );

    expect(user.email).toBe('jane@example.com');
    expect(user.hasPassword).toBe(false);
    expect(user.googleLinked).toBe(true);
  });

  it('a user without credentials has none of them', () => {
    const user = userWith();

    expect(user.email).toBeNull();
    expect(user.hasPassword).toBe(false);
    expect(user.googleLinked).toBe(false);
  });
});
