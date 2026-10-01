import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { Inject } from '@nestjs/common';
import { ListSessionsQuery } from './list-sessions.query.js';
import type { ISessionRepository, Session } from '../../domain/index.js';

@QueryHandler(ListSessionsQuery)
export class ListSessionsHandler implements IQueryHandler<ListSessionsQuery> {
  constructor(
    @Inject('ISessionRepository')
    private readonly sessionRepo: ISessionRepository,
  ) {}

  /** The user's live sessions, most recently used first. */
  async execute(query: ListSessionsQuery): Promise<Session[]> {
    return this.sessionRepo.findActiveByUser(query.userId, new Date());
  }
}
