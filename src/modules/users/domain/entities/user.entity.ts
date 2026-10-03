import { CredentialProvider, UserRole } from '@prisma/client';

export class UserCredential {
  constructor(
    public readonly id: string,
    public readonly provider: CredentialProvider,
    public readonly identifier: string,
    public readonly secret: string | null,
    public readonly createdAt: Date,
    public updatedAt: Date,
  ) {}
}

export class User {
  constructor(
    public readonly id: string,
    public readonly role: UserRole,
    public displayName: string | null,
    public avatarUrl: string | null,
    public readonly createdAt: Date,
    public updatedAt: Date,
    public readonly credentials: UserCredential[] = [],
  ) {}

  public static create(
    id: string,
    role: UserRole = UserRole.CUSTOMER,
    displayName: string | null = null,
    avatarUrl: string | null = null,
  ): User {
    const now = new Date();
    return new User(id, role, displayName, avatarUrl, now, now, []);
  }

  /** The address of the email credential, which every account has. */
  public get email(): string | null {
    return this.emailCredential?.identifier ?? null;
  }

  /** Whether the account can log in with a password (a Google-only account cannot). */
  public get hasPassword(): boolean {
    return this.emailCredential?.secret != null;
  }

  public get googleLinked(): boolean {
    return this.credentials.some(
      (c) => c.provider === CredentialProvider.GOOGLE,
    );
  }

  private get emailCredential(): UserCredential | undefined {
    return this.credentials.find(
      (c) => c.provider === CredentialProvider.EMAIL,
    );
  }

  public addCredential(
    id: string,
    provider: CredentialProvider,
    identifier: string,
    secret: string | null,
  ): void {
    const now = new Date();
    this.credentials.push(
      new UserCredential(id, provider, identifier, secret, now, now),
    );
  }
}
