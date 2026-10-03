import { describe, it, expect } from 'vitest';
import { describeFailure } from './job-failure.js';

describe('describeFailure', () => {
  it('keeps the error code, response code and name, and leaves the message out', () => {
    const error = Object.assign(
      new Error('550 5.1.1 <a@example.com> unknown'),
      { code: 'EENVELOPE', responseCode: 550 },
    );

    expect(describeFailure(error)).toBe('EENVELOPE 550 Error');
  });

  it('strips anything that is not a plain word character, so a code cannot smuggle text into the log', () => {
    expect(describeFailure({ code: 'a@b.com\nBcc: x' })).toBe('ab.comBccx');
  });

  it('copes with values that are not errors', () => {
    expect(describeFailure(undefined)).toBe('unknown error');
    expect(describeFailure('boom')).toBe('unknown error');
    expect(describeFailure(null)).toBe('unknown error');
  });
});
