/**
 * The Lua scripts behind the stock numbers in Redis. Redis runs one script from start to end
 * before it starts the next, so each of these is one indivisible step: nobody can slip in
 * between its "check" and its "change". That is the whole point of using Lua here.
 *
 * Every key a script touches is passed in `KEYS` (never built inside the script), the habit that
 * keeps scripts working on a Redis Cluster.
 */

/**
 * Takes the units of a whole order, or nothing.
 *
 * KEYS[1]  "being held" record of the order      KEYS[2]  index of orders being held
 * KEYS[3..] one available-units key per item
 * ARGV[1]  order id    ARGV[2]  the record (JSON)    ARGV[3]  record TTL in seconds
 * ARGV[4..] the quantity of each item, in the same order as KEYS[3..]
 *
 * Returns { code, ... }:
 *   0                 held
 *   1, i1, i2, ...    these items (positions) have no number in Redis: rebuild them first
 *   2, i1, have1, ... these items (positions) are short, with the units Redis has for each
 *   3                 this order is already being held by another request
 */
export const HOLD_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  return {3}
end

local count = #KEYS - 2

local missing = {}
for i = 1, count do
  if redis.call('EXISTS', KEYS[2 + i]) == 0 then
    missing[#missing + 1] = i
  end
end
if #missing > 0 then
  return {1, unpack(missing)}
end

local short = {}
for i = 1, count do
  local have = tonumber(redis.call('GET', KEYS[2 + i]))
  if have < tonumber(ARGV[3 + i]) then
    short[#short + 1] = i
    short[#short + 1] = have
  end
end
if #short > 0 then
  return {2, unpack(short)}
end

for i = 1, count do
  redis.call('DECRBY', KEYS[2 + i], ARGV[3 + i])
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
local now = redis.call('TIME')
redis.call('ZADD', KEYS[2], now[1] * 1000 + math.floor(now[2] / 1000), ARGV[1])
return {0}
`;

/**
 * Gives back what HOLD took, but only if the order's "being held" record still exists, and removes
 * the record in the same step. A request that undoes its own hold and a repair job that finds the
 * same hold leaked can both run it: whichever gets there first adds the units back, the other
 * finds no record and adds nothing.
 *
 * KEYS[1]  record    KEYS[2]  index    KEYS[3..] one available-units key per item
 * ARGV[1]  order id    ARGV[2..] the quantity of each item
 * Returns 1 when it gave the units back, 0 when there was no record.
 */
export const UNDO_HOLD_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  redis.call('ZREM', KEYS[2], ARGV[1])
  return 0
end
for i = 1, #KEYS - 2 do
  if redis.call('EXISTS', KEYS[2 + i]) == 1 then
    redis.call('INCRBY', KEYS[2 + i], ARGV[1 + i])
  end
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

/**
 * Adds units back after a release. A key that does not exist is skipped, NOT created: a number
 * made from the released quantity alone ("2") would be wrong, since the real number is what
 * Postgres says. The next read rebuilds it.
 *
 * KEYS[1..] one available-units key per item    ARGV[1..] the quantity of each
 */
export const GIVE_BACK_SCRIPT = `
for i = 1, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then
    redis.call('INCRBY', KEYS[i], ARGV[i])
  end
end
return 1
`;
