import { describe, it, expect } from 'vitest';
import { matchesTopic } from './topic-match.js';

describe('matchesTopic', () => {
  it.each([
    ['order.created', 'order.created', true],
    ['order.created', 'order.status_changed', false],
    ['order.*', 'order.created', true],
    ['order.*', 'order.status_changed', true],
    ['order.*', 'order', false],
    ['order.*', 'order.created.again', false],
    ['*.created', 'order.created', true],
    ['*.created', 'payment.created', true],
    ['*.created', 'order.status_changed', false],
    ['#', 'order.created', true],
    ['#', 'order', true],
    ['order.#', 'order', true],
    ['order.#', 'order.created', true],
    ['order.#', 'order.status.changed', true],
    ['order.#', 'payment.created', false],
    ['#.created', 'order.created', true],
    ['#.created', 'created', true],
    ['#.created', 'order.status_changed', false],
    ['order.*.done', 'order.x.done', true],
    ['order.*.done', 'order.done', false],
    ['order.#.done', 'order.done', true],
    ['order.#.done', 'order.a.b.done', true],
    ['payment.*', 'order.created', false],
  ])('pattern %s against %s is %s', (pattern, name, expected) => {
    expect(matchesTopic(pattern, name)).toBe(expected);
  });
});
