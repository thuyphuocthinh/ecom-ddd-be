import { OrderStatus } from '../../domain/index.js';
import { InMemoryOrderStatusFeed } from './in-memory-order-status-feed.js';
import { LocalWatchers } from './local-watchers.js';

const update = (orderId: string, status = OrderStatus.CONFIRMED) => ({
  orderId,
  status,
});

describe('LocalWatchers', () => {
  it('gives an update only to the listeners of its order (AC-3)', () => {
    const watchers = new LocalWatchers();
    const forX = vi.fn();
    const forY = vi.fn();
    watchers.add('X', forX);
    watchers.add('Y', forY);

    watchers.dispatch(update('Y'));

    expect(forY).toHaveBeenCalledWith(update('Y'));
    expect(forX).not.toHaveBeenCalled();
  });

  it('gives an update to every listener of the same order', () => {
    const watchers = new LocalWatchers();
    const first = vi.fn();
    const second = vi.fn();
    watchers.add('X', first);
    watchers.add('X', second);

    watchers.dispatch(update('X'));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('counts the same function added twice as two listeners, and removes only the one asked (AC-7)', () => {
    const watchers = new LocalWatchers();
    const listener = vi.fn();
    const removeFirst = watchers.add('X', listener);
    watchers.add('X', listener);
    expect(watchers.count('X')).toBe(2);

    removeFirst();

    expect(watchers.count('X')).toBe(1);
    watchers.dispatch(update('X'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('forgets the order when its last listener is removed, and removing twice is harmless (AC-7)', () => {
    const watchers = new LocalWatchers();
    const remove = watchers.add('X', vi.fn());

    remove();
    remove();

    expect(watchers.count('X')).toBe(0);
  });

  it('does nothing for an order nobody watches', () => {
    expect(() => new LocalWatchers().dispatch(update('nobody'))).not.toThrow();
  });

  it('keeps going when one listener throws', () => {
    const watchers = new LocalWatchers();
    const after = vi.fn();
    watchers.add('X', () => {
      throw new Error('broken');
    });
    watchers.add('X', after);

    watchers.dispatch(update('X'));

    expect(after).toHaveBeenCalledTimes(1);
  });

  it('lets a listener remove itself while it is being called', () => {
    const watchers = new LocalWatchers();
    const later = vi.fn();
    const remove = watchers.add('X', () => remove());
    watchers.add('X', later);

    watchers.dispatch(update('X'));

    expect(later).toHaveBeenCalledTimes(1);
    expect(watchers.count('X')).toBe(1);
  });
});

describe('InMemoryOrderStatusFeed', () => {
  it('hands a published update to the listeners of the order', async () => {
    const feed = new InMemoryOrderStatusFeed();
    const listener = vi.fn();
    feed.watch('X', listener);

    await feed.publish(update('X', OrderStatus.CANCELLED));

    expect(listener).toHaveBeenCalledWith(update('X', OrderStatus.CANCELLED));
  });

  it('stops handing updates after the listener is removed', async () => {
    const feed = new InMemoryOrderStatusFeed();
    const listener = vi.fn();
    const stop = feed.watch('X', listener);
    stop();

    await feed.publish(update('X'));

    expect(listener).not.toHaveBeenCalled();
  });
});
