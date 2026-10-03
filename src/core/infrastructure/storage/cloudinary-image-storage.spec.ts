import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  CloudinaryImageStorage,
  type CloudinaryClient,
} from './cloudinary-image-storage.js';
import { UnconfiguredImageStorage } from './unconfigured-image-storage.js';
import {
  cloudinarySettingsFromEnv,
  createImageStorage,
} from './image-storage.factory.js';
import type { ImageFit, ImageType } from './image-storage.port.js';

const SETTINGS = {
  cloudName: 'demo',
  apiKey: '123456',
  apiSecret: 'super-secret-value',
  folder: 'ecom',
};
const GOOD_ADDRESS =
  'https://res.cloudinary.com/demo/image/upload/v1/ecom/avatars/u-1.png';
const AVATAR_FIT: ImageFit = {
  width: 256,
  height: 256,
  crop: 'fill',
  focus: 'face',
};
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'resolved',
    (e: any) => e.code ?? e.constructor.name,
  );

describe('CloudinaryImageStorage', () => {
  let client: {
    upload: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  let logged: string[];
  const storage = () =>
    new CloudinaryImageStorage(SETTINGS, client as unknown as CloudinaryClient);
  const upload = (
    options: {
      type?: ImageType;
      path?: string;
      fit?: ImageFit;
    } = {},
  ) =>
    storage().upload({
      path: options.path ?? 'avatars/u-1',
      image: Buffer.from('FILE-CONTENT'),
      type: options.type ?? 'png',
      fit: options.fit ?? AVATAR_FIT,
    });

  beforeEach(() => {
    vi.restoreAllMocks();
    logged = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
      logged.push(String(m));
    });
    client = {
      upload: vi.fn().mockResolvedValue({ secure_url: GOOD_ADDRESS }),
      destroy: vi.fn().mockResolvedValue({ result: 'ok' }),
    };
  });

  it('stores the picture under the app folder at the given path, replacing what was there', async () => {
    expect(await upload()).toBe(GOOD_ADDRESS);

    const [image, options] = client.upload.mock.calls[0];
    expect(image.toString()).toBe('FILE-CONTENT');
    expect(options).toMatchObject({
      public_id: 'ecom/avatars/u-1',
      overwrite: true,
      invalidate: true,
      allowed_formats: ['png'],
    });
    expect(options.timeout).toBeGreaterThan(0);
  });

  it('cuts to a square around the face when asked to', async () => {
    await upload();

    expect(client.upload.mock.calls[0][1].transformation).toEqual([
      {
        width: 256,
        height: 256,
        crop: 'fill',
        gravity: 'face',
        quality: 'auto',
      },
    ]);
  });

  it('shrinks to fit without enlarging, or fills from the centre, when asked to', async () => {
    await upload({ fit: { width: 800, height: 800, crop: 'limit' } });
    await upload({
      fit: { width: 100, height: 50, crop: 'fill', focus: 'center' },
    });

    const [limit, center] = client.upload.mock.calls.map(
      (call) => call[1].transformation[0],
    );
    expect(limit).toEqual({
      width: 800,
      height: 800,
      crop: 'limit',
      quality: 'auto',
    });
    expect(center).not.toHaveProperty('gravity');
    expect(center).toMatchObject({ crop: 'fill', width: 100, height: 50 });
  });

  it('names a JPEG the way Cloudinary does', async () => {
    await upload({ type: 'jpeg' });

    expect(client.upload.mock.calls[0][1].allowed_formats).toEqual(['jpg']);
  });

  it.each([
    ['another cloud', 'https://res.cloudinary.com/other/image/upload/a.png'],
    [
      'a plain http address',
      'http://res.cloudinary.com/demo/image/upload/a.png',
    ],
    ['another host', 'https://evil.example.com/demo/a.png'],
    ['a look-alike host', 'https://res.cloudinary.com.evil.example/demo/a.png'],
    ['nothing', undefined],
  ])('does not trust an answer pointing at %s', async (_name, url) => {
    client.upload.mockResolvedValue({ secure_url: url });

    expect(await code(upload())).toBe('STO-002');
  });

  it('turns "Cloudinary cannot read this as an image" (400) into STO-003', async () => {
    client.upload.mockRejectedValue({
      message: 'Invalid image file',
      http_code: 400,
    });

    expect(await code(upload())).toBe('STO-003');
  });

  it.each([
    ['a network failure', new Error('socket hang up')],
    ['a timeout', { message: 'Request Timeout', http_code: 499 }],
    ['wrong keys', { message: 'Invalid Signature', http_code: 401 }],
    ['no reason at all', undefined],
  ])('answers STO-002 for %s', async (_name, failure) => {
    client.upload.mockRejectedValue(failure);

    expect(await code(upload())).toBe('STO-002');
  });

  it('logs only the reason of a failure, not the keys or the file', async () => {
    client.upload.mockRejectedValue(new Error('socket hang up'));

    await upload().catch(() => undefined);

    const everything = logged.join('\n');
    expect(everything).toContain('socket hang up');
    for (const secret of [
      SETTINGS.apiSecret,
      SETTINGS.apiKey,
      'FILE-CONTENT',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  it('leaves a trace in the log when Cloudinary calls the file unreadable, since our own options can cause that too', async () => {
    client.upload.mockRejectedValue({
      message: 'Invalid transformation',
      http_code: 400,
    });
    const warnings: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: any) => {
      warnings.push(String(m));
    });

    await upload().catch(() => undefined);

    expect(warnings.join(String.fromCharCode(10))).toContain(
      'Invalid transformation',
    );
    expect(warnings.join(String.fromCharCode(10))).not.toContain(
      'FILE-CONTENT',
    );
  });

  it.each([
    '',
    '/avatars/u-1',
    'avatars/',
    'avatars//u-1',
    '../secret',
    'avatars/u 1',
    'avatars/u-1.png',
  ])('refuses the path %j, which is a bug in the caller', async (path) => {
    await expect(upload({ path })).rejects.toThrow(/Invalid image path/);
    await expect(storage().delete(path)).rejects.toThrow(/Invalid image path/);
    expect(client.upload).not.toHaveBeenCalled();
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it('removes the picture at the same place and clears the cache', async () => {
    await storage().delete('avatars/u-1');

    expect(client.destroy).toHaveBeenCalledWith('ecom/avatars/u-1', {
      invalidate: true,
      timeout: expect.any(Number),
    });
  });

  it('answers STO-002 when removing fails', async () => {
    client.destroy.mockRejectedValue(new Error('down'));

    expect(await code(storage().delete('avatars/u-1'))).toBe('STO-002');
  });
});

describe('UnconfiguredImageStorage', () => {
  it('refuses to upload with STO-001 and has nothing to remove, without an error', async () => {
    const storage = new UnconfiguredImageStorage();

    expect(
      await code(
        storage.upload({
          path: 'avatars/u-1',
          image: Buffer.from('x'),
          type: 'png',
          fit: AVATAR_FIT,
        }),
      ),
    ).toBe('STO-001');
    await expect(storage.delete('avatars/u-1')).resolves.toBeUndefined();
  });
});

describe('image storage choice', () => {
  const ENV = {
    CLOUDINARY_CLOUD_NAME: ' demo ',
    CLOUDINARY_API_KEY: '123456',
    CLOUDINARY_API_SECRET: 'super-secret-value',
  };

  it('uses Cloudinary when all three settings are present, with the default folder', () => {
    expect(cloudinarySettingsFromEnv(ENV)).toEqual({
      cloudName: 'demo',
      apiKey: '123456',
      apiSecret: 'super-secret-value',
      folder: 'ecom',
    });
    expect(createImageStorage(ENV)).toBeInstanceOf(CloudinaryImageStorage);
  });

  it('takes the folder from CLOUDINARY_FOLDER', () => {
    const settings = cloudinarySettingsFromEnv({
      ...ENV,
      CLOUDINARY_FOLDER: 'shop/dev',
    });

    expect(settings?.folder).toBe('shop/dev');
  });

  it.each([
    {},
    { CLOUDINARY_CLOUD_NAME: 'demo' },
    { ...ENV, CLOUDINARY_API_SECRET: '  ' },
  ])('falls back to "not configured" for %j', (env) => {
    expect(cloudinarySettingsFromEnv(env)).toBeNull();
    expect(createImageStorage(env)).toBeInstanceOf(UnconfiguredImageStorage);
  });
});
