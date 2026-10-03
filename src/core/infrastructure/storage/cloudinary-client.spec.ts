import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => ({
  config: vi.fn(),
  upload_stream: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('cloudinary', () => ({
  v2: {
    config: sdk.config,
    uploader: { upload_stream: sdk.upload_stream, destroy: sdk.destroy },
  },
}));

const { createCloudinaryClient } =
  await import('./cloudinary-image-storage.js');

const SETTINGS = {
  cloudName: 'demo',
  apiKey: 'key-1',
  apiSecret: 'secret-1',
  folder: 'ecom',
};

/** What the SDK does: takes the options and a callback, returns a stream that is ended with the bytes */
const streamAnswering = (answer: { error?: unknown; result?: unknown }) => {
  const received: Buffer[] = [];
  sdk.upload_stream.mockImplementation(
    (_options: unknown, done: (error: unknown, result: unknown) => void) => ({
      end: (bytes: Buffer) => {
        received.push(bytes);
        done(answer.error, answer.result);
      },
    }),
  );
  return received;
};

describe('createCloudinaryClient (the thin layer over the SDK)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('configures the SDK with the account, over https', () => {
    createCloudinaryClient(SETTINGS);

    expect(sdk.config).toHaveBeenCalledWith({
      cloud_name: 'demo',
      api_key: 'key-1',
      api_secret: 'secret-1',
      secure: true,
    });
  });

  it('streams the bytes with the options and resolves with the result', async () => {
    const received = streamAnswering({ result: { secure_url: 'https://x' } });

    const result = await createCloudinaryClient(SETTINGS).upload(
      Buffer.from('BYTES'),
      { public_id: 'ecom/avatars/u-1' },
    );

    expect(result).toEqual({ secure_url: 'https://x' });
    expect(received[0].toString()).toBe('BYTES');
    expect(sdk.upload_stream.mock.calls[0][0]).toEqual({
      public_id: 'ecom/avatars/u-1',
    });
  });

  it('rejects with the SDK error', async () => {
    streamAnswering({ error: { message: 'bad', http_code: 400 } });

    await expect(
      createCloudinaryClient(SETTINGS).upload(Buffer.from('x'), {}),
    ).rejects.toMatchObject({ http_code: 400 });
  });

  it('rejects when the SDK gives neither an error nor a result', async () => {
    streamAnswering({});

    await expect(
      createCloudinaryClient(SETTINGS).upload(Buffer.from('x'), {}),
    ).rejects.toBeDefined();
  });

  it('removes by public id with the options', async () => {
    sdk.destroy.mockResolvedValue({ result: 'ok' });

    await createCloudinaryClient(SETTINGS).destroy('ecom/avatars/u-1', {
      invalidate: true,
    });

    expect(sdk.destroy).toHaveBeenCalledWith('ecom/avatars/u-1', {
      invalidate: true,
    });
  });
});
