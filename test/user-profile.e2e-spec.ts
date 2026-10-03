import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { ClsService } from 'nestjs-cls';
import { AppModule } from './../src/app.module.js';
import {
  PrismaService,
  AllExceptionsFilter,
  ResponseInterceptor,
  RedisService,
  EMAIL_SENDER,
  AuthErrorCodes,
  IMAGE_STORAGE,
  StorageErrorCodes,
  UnconfiguredImageStorage,
  DomainException,
} from './../src/core/index.js';
import type { EmailMessage, ImageUpload } from './../src/core/index.js';
import {
  AuthDomainException,
  GOOGLE_TOKEN_VERIFIER,
  type GoogleIdentity,
} from './../src/modules/auth/domain/index.js';

const API = '/api/v1';
const PASSWORD = 'Sunny-Giraffe-42!';
const CLIENT_ID = 'e2e-web.apps.googleusercontent.com';

const mailbox = {
  sent: [] as EmailMessage[],
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  },
};

/** Stands in for Google: a "token" is just JSON saying what the real one would have proven. */
const fakeVerifier = {
  async verify(idToken: string): Promise<GoogleIdentity> {
    try {
      const t = JSON.parse(idToken);
      return {
        sub: t.sub,
        email: t.email,
        emailVerified: true,
        name: t.name,
        picture: t.picture,
        expiresAt: new Date(Date.now() + 3600_000),
        tokenId: `${t.sub}:${t.n}`,
      };
    } catch {
      throw new AuthDomainException(AuthErrorCodes.INVALID_GOOGLE_TOKEN);
    }
  },
};

/** Stands in for Cloudinary: remembers what it was given and can be told to misbehave. */
const storage = {
  mode: 'ok' as 'ok' | 'unavailable' | 'unconfigured' | 'slow',
  uploads: [] as ImageUpload[],
  deletes: [] as string[],
  deleteFails: false,
  counter: 0,
  active: 0,
  maxActive: 0,
  /** What finished, in order: 'upload' or 'delete' */
  events: [] as string[],
  async upload(request: ImageUpload): Promise<string> {
    if (this.mode === 'unconfigured') {
      return new UnconfiguredImageStorage().upload(request);
    }
    if (this.mode === 'unavailable') {
      throw new DomainException(StorageErrorCodes.UNAVAILABLE);
    }
    this.maxActive = Math.max(this.maxActive, ++this.active);
    if (this.mode === 'slow') {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    this.active--;
    this.uploads.push(request);
    this.events.push('upload');
    return `https://res.cloudinary.com/e2e/image/upload/v${++this.counter}/${request.path}.png`;
  },
  async delete(path: string): Promise<void> {
    if (this.deleteFails) throw new Error('storage down');
    this.deletes.push(path);
    this.events.push('delete');
  },
  reset() {
    this.mode = 'ok';
    this.uploads = [];
    this.deletes = [];
    this.deleteFails = false;
    this.counter = 0;
    this.active = 0;
    this.maxActive = 0;
    this.events = [];
  },
};

const SIGNATURES: Record<string, number[]> = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff, 0xe0],
};
/** A file that starts like the given kind of picture and is `size` bytes long */
const picture = (kind: 'png' | 'jpeg' | 'webp', size = 1000): Buffer => {
  const head =
    kind === 'webp'
      ? Buffer.concat([
          Buffer.from('RIFF', 'latin1'),
          Buffer.from([0, 0, 0, 0]),
          Buffer.from('WEBP', 'latin1'),
        ])
      : Buffer.from(SIGNATURES[kind]);
  return Buffer.concat([
    head,
    Buffer.alloc(Math.max(0, size - head.length), 7),
  ]);
};

describe('User profile (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  const original = { ...process.env };

  const http = () => request(app.getHttpServer());
  const authed = (token: string) => ({ Authorization: `Bearer ${token}` });
  const me = (token: string) =>
    http().get(`${API}/users/me`).set(authed(token));
  const rename = (token: string, body: unknown) =>
    http()
      .patch(`${API}/users/me`)
      .set(authed(token))
      .send(body as object);
  const upload = (
    token: string,
    file: Buffer,
    filename = 'avatar.png',
    contentType = 'image/png',
  ) =>
    http()
      .put(`${API}/users/me/avatar`)
      .set(authed(token))
      .attach('file', file, { filename, contentType });
  const removeAvatar = (token: string) =>
    http().delete(`${API}/users/me/avatar`).set(authed(token));

  const buildApp = async (): Promise<INestApplication> => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EMAIL_SENDER)
      .useValue(mailbox)
      .overrideProvider(GOOGLE_TOKEN_VERIFIER)
      .useValue(fakeVerifier)
      .overrideProvider(IMAGE_STORAGE)
      .useValue(storage)
      .compile();
    const instance = module.createNestApplication();
    instance.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    instance.useGlobalFilters(
      new AllExceptionsFilter(instance.get(ClsService)),
    );
    instance.useGlobalInterceptors(new ResponseInterceptor());
    instance.setGlobalPrefix(API.replace('/', ''));
    await instance.init();
    return instance;
  };

  /** A person who registered with an email and password */
  const registerWithPassword = async (email: string, displayName?: string) => {
    await http()
      .post(`${API}/auth/register`)
      .send({ email, password: PASSWORD, displayName })
      .expect(202);
    const code = [...mailbox.sent]
      .reverse()
      .find((m) => m.to === email)!
      .text.match(/\b(\d{6})\b/)![1];
    const res = await http()
      .post(`${API}/auth/verify-email`)
      .send({ email, code, password: PASSWORD })
      .expect(200);
    mailbox.sent.length = 0;
    return res.body.data.accessToken as string;
  };

  const googleSignIn = async (
    sub: string,
    email: string,
    name?: string,
    pictureUrl?: string,
  ) => {
    const res = await http()
      .post(`${API}/auth/google`)
      .send({
        idToken: JSON.stringify({
          sub,
          email,
          name,
          picture: pictureUrl,
          n: randomUUID(),
        }),
      })
      .expect(200);
    return res.body.data.accessToken as string;
  };

  const rowOf = (email: string) =>
    prisma.user.findFirstOrThrow({
      where: {
        credentials: { some: { provider: 'EMAIL', identifier: email } },
      },
      include: { credentials: true },
    });

  beforeAll(async () => {
    process.env.GOOGLE_CLIENT_IDS = CLIENT_ID;
    app = await buildApp();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
  });

  afterAll(async () => {
    await app.close();
    process.env = { ...original };
  });

  beforeEach(async () => {
    await prisma.userCredential.deleteMany();
    await prisma.user.deleteMany();
    await redis.getClient().flushdb();
    mailbox.sent.length = 0;
    storage.reset();
  });

  describe('AC-1: seeing my profile', () => {
    it('shows my details and how I can sign in, and nothing secret', async () => {
      const token = await registerWithPassword('jane@example.com', 'Jane');

      const res = await me(token).expect(200);

      expect(Object.keys(res.body.data).sort()).toEqual(
        [
          'avatarUrl',
          'createdAt',
          'displayName',
          'email',
          'googleLinked',
          'hasPassword',
          'id',
          'role',
        ].sort(),
      );
      expect(res.body.data).toMatchObject({
        email: 'jane@example.com',
        displayName: 'Jane',
        role: 'CUSTOMER',
        hasPassword: true,
        googleLinked: false,
        avatarUrl: null,
      });
      expect(JSON.stringify(res.body)).not.toContain('argon2');
    });

    it('says so when the account has only Google and no password', async () => {
      const token = await googleSignIn('g-1', 'gina@example.com', 'Gina');

      const res = await me(token).expect(200);

      expect(res.body.data).toMatchObject({
        email: 'gina@example.com',
        hasPassword: false,
        googleLinked: true,
      });
    });
  });

  describe('AC-1: both ways of signing in', () => {
    it('shows a password and a linked Google account together', async () => {
      const token = await registerWithPassword('jane@example.com', 'Jane');
      await http()
        .post(`${API}/auth/google/link`)
        .set(authed(token))
        .send({
          idToken: JSON.stringify({
            sub: 'g-both',
            email: 'jane@example.com',
            n: randomUUID(),
          }),
          currentPassword: PASSWORD,
        })
        .expect(204);

      const res = await me(token).expect(200);

      expect(res.body.data).toMatchObject({
        hasPassword: true,
        googleLinked: true,
      });
    });
  });

  describe('AC-2 and AC-3: changing the display name', () => {
    it('stores the tidied name, for me only, and touches nothing else', async () => {
      const token = await registerWithPassword('jane@example.com', 'Jane');
      await registerWithPassword('other@example.com', 'Other');
      const before = await rowOf('jane@example.com');

      const res = await rename(token, {
        displayName: '  Nguyễn \n Văn   A ',
      }).expect(200);

      expect(res.body.data.displayName).toBe('Nguyễn Văn A');
      const after = await rowOf('jane@example.com');
      expect(after.displayName).toBe('Nguyễn Văn A');
      expect(after.role).toBe(before.role);
      expect(after.avatarUrl).toBe(before.avatarUrl);
      expect(after.credentials.map((c) => [c.provider, c.secret])).toEqual(
        before.credentials.map((c) => [c.provider, c.secret]),
      );
      expect((await rowOf('other@example.com')).displayName).toBe('Other');
    });

    it('lets a Google person replace the name Google filled in', async () => {
      const token = await googleSignIn('g-1', 'gina@example.com', 'Gina G');

      await rename(token, { displayName: 'Gina' }).expect(200);

      expect((await me(token)).body.data.displayName).toBe('Gina');
    });

    it.each([
      ['empty', { displayName: '' }],
      ['only spaces', { displayName: '    ' }],
      ['only invisible characters', { displayName: '​​' }],
      ['101 characters', { displayName: 'a'.repeat(101) }],
      ['not a string', { displayName: 123 }],
      ['missing', {}],
      ['an unknown field next to it', { displayName: 'Jane', role: 'ADMIN' }],
    ])('refuses a name that is %s and changes nothing', async (_name, body) => {
      const token = await registerWithPassword('jane@example.com', 'Jane');

      await rename(token, body).expect(400);

      expect((await rowOf('jane@example.com')).displayName).toBe('Jane');
    });

    it('cannot be used to change the role', async () => {
      const token = await registerWithPassword('jane@example.com', 'Jane');

      await rename(token, { displayName: 'Jane', role: 'ADMIN' }).expect(400);

      expect((await rowOf('jane@example.com')).role).toBe('CUSTOMER');
    });
  });

  describe('AC-4 and AC-6: uploading the avatar', () => {
    it.each(['png', 'jpeg', 'webp'] as const)(
      'accepts a %s picture, hands it to the storage and keeps the address',
      async (kind) => {
        const token = await registerWithPassword('jane@example.com');
        const file = picture(kind);

        const res = await upload(token, file).expect(200);

        const row = await rowOf('jane@example.com');
        expect(storage.uploads).toHaveLength(1);
        expect(storage.uploads[0]).toMatchObject({
          path: `avatars/${row.id}`,
          type: kind,
          fit: { width: 256, height: 256, crop: 'fill', focus: 'face' },
        });
        expect(storage.uploads[0].image.equals(file)).toBe(true);
        expect(res.body.data.avatarUrl).toBe(row.avatarUrl);
        expect(row.avatarUrl).toMatch(
          /^https:\/\/res\.cloudinary\.com\/e2e\/.+/,
        );
      },
    );

    it('accepts a picture of exactly 2 MB', async () => {
      const token = await registerWithPassword('jane@example.com');

      await upload(token, picture('png', 2 * 1024 * 1024)).expect(200);
    });

    it('replaces the picture when another one is uploaded', async () => {
      const token = await registerWithPassword('jane@example.com');
      const first = (await upload(token, picture('png')).expect(200)).body.data
        .avatarUrl;

      const second = (await upload(token, picture('jpeg')).expect(200)).body
        .data.avatarUrl;

      expect(second).not.toBe(first);
      expect((await rowOf('jane@example.com')).avatarUrl).toBe(second);
    });

    it('replaces the picture Google supplied', async () => {
      const token = await googleSignIn(
        'g-1',
        'gina@example.com',
        'Gina',
        'https://lh3.googleusercontent.com/a/p',
      );

      const res = await upload(token, picture('png')).expect(200);

      expect(res.body.data.avatarUrl).toContain('res.cloudinary.com');
    });
  });

  describe('AC-5: a wrong file is refused', () => {
    const expectNothingStored = async () => {
      expect(storage.uploads).toHaveLength(0);
      expect((await rowOf('jane@example.com')).avatarUrl).toBeNull();
    };

    it.each([
      [
        'text renamed to .png',
        Buffer.from('just some text, no picture'),
        'a.png',
        'image/png',
      ],
      [
        'an SVG',
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
        'a.svg',
        'image/svg+xml',
      ],
      [
        'an SVG calling itself a PNG',
        Buffer.from('<svg onload="alert(1)"/>'),
        'a.png',
        'image/png',
      ],
      ['a GIF', Buffer.from('GIF89a......'), 'a.gif', 'image/gif'],
      ['a PDF', Buffer.from('%PDF-1.7 ......'), 'a.pdf', 'application/pdf'],
      [
        'a program',
        Buffer.from('MZ......'),
        'a.exe',
        'application/octet-stream',
      ],
    ])(
      'refuses %s with USR-003, whatever name and type it claims',
      async (_name, file, filename, type) => {
        const token = await registerWithPassword('jane@example.com');

        const res = await upload(token, file, filename, type).expect(400);

        expect(res.body.code).toBe('USR-003');
        expect(res.body.errors.reason).toBeTruthy();
        await expectNothingStored();
      },
    );

    it('refuses an empty file', async () => {
      const token = await registerWithPassword('jane@example.com');

      const res = await upload(token, Buffer.alloc(0)).expect(400);

      expect(res.body.code).toBe('USR-003');
      await expectNothingStored();
    });

    it('answers 413 for a picture over 2 MB', async () => {
      const token = await registerWithPassword('jane@example.com');

      await upload(token, picture('png', 2 * 1024 * 1024 + 1)).expect(413);

      await expectNothingStored();
    });

    it('refuses a request with no file', async () => {
      const token = await registerWithPassword('jane@example.com');

      const res = await http()
        .put(`${API}/users/me/avatar`)
        .set(authed(token))
        .set('Content-Type', 'multipart/form-data; boundary=x')
        .send('--x--\r\n')
        .expect(400);

      expect(res.body.code).toBe('USR-003');
      await expectNothingStored();
    });

    it('refuses any text field next to the file, so a body of many small fields cannot be kept in memory', async () => {
      const token = await registerWithPassword('jane@example.com');

      await http()
        .put(`${API}/users/me/avatar`)
        .set(authed(token))
        .field('note', 'not wanted')
        .attach('file', picture('png'), 'a.png')
        .expect(400);

      await expectNothingStored();
    });

    it('refuses a file sent under another field name', async () => {
      const token = await registerWithPassword('jane@example.com');

      await http()
        .put(`${API}/users/me/avatar`)
        .set(authed(token))
        .attach('image', picture('png'), 'a.png')
        .expect(400);

      await expectNothingStored();
    });

    it('refuses more than one file', async () => {
      const token = await registerWithPassword('jane@example.com');

      await http()
        .put(`${API}/users/me/avatar`)
        .set(authed(token))
        .attach('file', picture('png'), 'a.png')
        .attach('file', picture('png'), 'b.png')
        .expect(400);

      await expectNothingStored();
    });

    it('refuses a JSON body', async () => {
      const token = await registerWithPassword('jane@example.com');

      await http()
        .put(`${API}/users/me/avatar`)
        .set(authed(token))
        .send({ file: 'abc' })
        .expect(400);

      await expectNothingStored();
    });
  });

  describe('AC-7: removing the avatar', () => {
    it('clears the address and the stored picture', async () => {
      const token = await registerWithPassword('jane@example.com');
      await upload(token, picture('png')).expect(200);
      const row = await rowOf('jane@example.com');

      await removeAvatar(token).expect(204);

      expect((await rowOf('jane@example.com')).avatarUrl).toBeNull();
      expect(storage.deletes).toEqual([`avatars/${row.id}`]);
      expect((await me(token)).body.data.avatarUrl).toBeNull();
    });

    it('removes the picture Google supplied, and it does not come back', async () => {
      const token = await googleSignIn(
        'g-1',
        'gina@example.com',
        'Gina',
        'https://lh3.googleusercontent.com/a/p',
      );

      await removeAvatar(token).expect(204);
      await googleSignIn(
        'g-1',
        'gina@example.com',
        'Gina',
        'https://lh3.googleusercontent.com/a/p',
      );

      expect((await me(token)).body.data.avatarUrl).toBeNull();
    });

    it('succeeds when there is no picture', async () => {
      const token = await registerWithPassword('jane@example.com');

      await removeAvatar(token).expect(204);
      await removeAvatar(token).expect(204);
    });

    it('still succeeds when the storage cannot remove the stored picture', async () => {
      const token = await registerWithPassword('jane@example.com');
      await upload(token, picture('png')).expect(200);
      storage.deleteFails = true;

      await removeAvatar(token).expect(204);

      expect((await rowOf('jane@example.com')).avatarUrl).toBeNull();
    });
  });

  describe('AC-8: the storage is not available', () => {
    it('answers 503 STO-001 when no image service is configured, while the rest keeps working', async () => {
      const token = await registerWithPassword('jane@example.com', 'Jane');
      storage.mode = 'unconfigured';

      const res = await upload(token, picture('png')).expect(503);

      expect(res.body.code).toBe('STO-001');
      await me(token).expect(200);
      await rename(token, { displayName: 'Jane D' }).expect(200);
      await removeAvatar(token).expect(204);
    });

    it('answers 503 STO-002 and keeps the old picture when the storage fails', async () => {
      const token = await registerWithPassword('jane@example.com');
      const kept = (await upload(token, picture('png')).expect(200)).body.data
        .avatarUrl;
      storage.mode = 'unavailable';

      const res = await upload(token, picture('jpeg')).expect(503);

      expect(res.body.code).toBe('STO-002');
      expect((await rowOf('jane@example.com')).avatarUrl).toBe(kept);
    });
  });

  describe('AC-9: login and limits', () => {
    it('needs a login for every endpoint', async () => {
      await http().get(`${API}/users/me`).expect(401);
      await http()
        .patch(`${API}/users/me`)
        .send({ displayName: 'x' })
        .expect(401);
      await http()
        .put(`${API}/users/me/avatar`)
        .attach('file', picture('png'), 'a.png')
        .expect(401);
      await http().delete(`${API}/users/me/avatar`).expect(401);
      expect(storage.uploads).toHaveLength(0);
    });

    it('allows 5 uploads per hour per user, then 429, and other users are not affected', async () => {
      const token = await registerWithPassword('jane@example.com');
      const other = await registerWithPassword('other@example.com');

      for (let i = 0; i < 5; i++)
        await upload(token, picture('png')).expect(200);
      await upload(token, picture('png')).expect(429);

      await upload(other, picture('png')).expect(200);
    });

    it('allows 20 name changes per 15 minutes per user, then 429', async () => {
      const token = await registerWithPassword('jane@example.com');

      for (let i = 0; i < 20; i++) {
        await rename(token, { displayName: `Jane ${i}` }).expect(200);
      }
      await rename(token, { displayName: 'one too many' }).expect(429);
    });
  });

  describe('AC-10: changes to the avatar at the same moment', () => {
    it('two uploads take turns (never both at the storage at once) and the profile ends with one of the two addresses', async () => {
      const token = await registerWithPassword('jane@example.com');
      storage.mode = 'slow';

      const [a, b] = await Promise.all([
        upload(token, picture('png')),
        upload(token, picture('jpeg')),
      ]);

      expect([a.status, b.status]).toEqual([200, 200]);
      expect(storage.uploads).toHaveLength(2);
      expect(storage.maxActive).toBe(1);
      const stored = (await rowOf('jane@example.com')).avatarUrl;
      expect([a.body.data.avatarUrl, b.body.data.avatarUrl]).toContain(stored);
      expect(stored).toMatch(/^https:\/\/res\.cloudinary\.com\//);
    });

    it('an upload and a removal at the same moment never leave an address pointing at a deleted picture', async () => {
      const token = await registerWithPassword('jane@example.com');
      storage.mode = 'slow';

      const [uploaded, removed] = await Promise.all([
        upload(token, picture('png')),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return removeAvatar(token);
        })(),
      ]);

      expect([uploaded.status, removed.status]).toEqual([200, 204]);
      const stored = (await rowOf('jane@example.com')).avatarUrl;
      // whichever came last decides, and the address and the stored picture agree about it
      expect(storage.events).toHaveLength(2);
      expect(storage.events.at(-1) === 'delete').toBe(stored === null);
    });
  });

  describe('AC-11: nothing private in the logs', () => {
    it('keeps the file name and the file content out of every log line, for success and for failure', async () => {
      const lines: string[] = [];
      const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map(
        (level) =>
          vi
            .spyOn(Logger.prototype, level)
            .mockImplementation((message: any, ...rest: any[]) => {
              lines.push(JSON.stringify([message, ...rest]));
            }),
      );
      try {
        const token = await registerWithPassword('jane@example.com');
        const file = Buffer.concat([
          picture('png', 200),
          Buffer.from('PRIVATE-MARKER'),
        ]);
        await upload(token, file, 'secret-holiday-photo.png').expect(200);
        storage.mode = 'unavailable';
        await upload(token, file, 'secret-holiday-photo.png').expect(503);
        await upload(
          token,
          Buffer.from('PRIVATE-MARKER'),
          'secret-holiday-photo.png',
        ).expect(400);

        const everything = lines.join('\n');
        for (const secret of ['secret-holiday-photo', 'PRIVATE-MARKER']) {
          expect(everything).not.toContain(secret);
        }
      } finally {
        spies.forEach((spy) => spy.mockRestore());
      }
    });
  });
});
