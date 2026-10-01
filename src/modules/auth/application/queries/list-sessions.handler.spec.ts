import { describe, it, expect, vi } from 'vitest';
import { ListSessionsHandler } from './list-sessions.handler.js';
import { ListSessionsQuery } from './list-sessions.query.js';
import type { ISessionRepository } from '../../domain/index.js';

describe('ListSessionsHandler', () => {
  it('returns the live sessions of the requested user (AC-2)', async () => {
    const sessions = [{ id: 'sid-a' }, { id: 'sid-b' }];
    const sessionRepo = {
      findActiveByUser: vi.fn().mockResolvedValue(sessions),
    };
    const handler = new ListSessionsHandler(
      sessionRepo as unknown as ISessionRepository,
    );

    await expect(
      handler.execute(new ListSessionsQuery('user-1')),
    ).resolves.toBe(sessions);
    expect(sessionRepo.findActiveByUser).toHaveBeenCalledWith(
      'user-1',
      expect.any(Date),
    );
  });
});
