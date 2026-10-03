import { describe, it, expect, afterEach } from 'vitest';
import { googleConfig, parseClientIds } from './google.config.js';

describe('parseClientIds', () => {
  it('splits on commas and trims', () => {
    expect(
      parseClientIds(
        'a.apps.googleusercontent.com , b.apps.googleusercontent.com',
      ),
    ).toEqual(['a.apps.googleusercontent.com', 'b.apps.googleusercontent.com']);
  });

  it('drops empty pieces', () => {
    expect(parseClientIds(',a, ,b,')).toEqual(['a', 'b']);
  });

  it.each([undefined, '', '   '])(
    'gives an empty list (feature off) for %j',
    (raw) => {
      expect(parseClientIds(raw)).toEqual([]);
    },
  );
});

describe('googleConfig', () => {
  const original = process.env.GOOGLE_CLIENT_IDS;
  afterEach(() => {
    if (original === undefined) delete process.env.GOOGLE_CLIENT_IDS;
    else process.env.GOOGLE_CLIENT_IDS = original;
  });

  it('reads GOOGLE_CLIENT_IDS when it is asked for, not when the file is loaded', () => {
    process.env.GOOGLE_CLIENT_IDS = 'x.apps.googleusercontent.com';

    expect(googleConfig().clientIds).toEqual(['x.apps.googleusercontent.com']);
  });

  it('has no client secret anywhere: only the ids are kept', () => {
    process.env.GOOGLE_CLIENT_IDS = 'x.apps.googleusercontent.com';

    expect(Object.keys(googleConfig())).toEqual(['clientIds']);
  });
});
