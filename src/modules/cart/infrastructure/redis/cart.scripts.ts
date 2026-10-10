/**
 * The Lua scripts behind the carts in Redis. Redis runs one script from start to end before it
 * starts the next, so each is one indivisible step: nobody can slip in between its "check the
 * limit" and its "write". That is what keeps two requests of the same user, at the same moment,
 * from losing an addition or going over a limit.
 *
 * A cart is one Redis hash per user: a field per SKU, its value a JSON {q, p, t}:
 *   q  units in the cart
 *   p  the price when it was put in
 *   t  when it was first put in (milliseconds, Redis clock)
 * The key is always passed in KEYS (never built inside the script).
 *
 * The scripts answer with a code, never with an error: 0 = done, others as written per script.
 * A value that cannot be read as JSON (it should never happen) is treated as "no line there".
 */

/**
 * Adds units of an item, creating the line when there is none.
 *
 * KEYS[1]  the cart
 * ARGV[1]  sku id   ARGV[2]  units to add   ARGV[3]  the price now
 * ARGV[4]  most lines   ARGV[5]  most units per line   ARGV[6]  time to live, in seconds
 *
 * Returns { 0, units now }    done
 *         { 1 }               a new line, but the cart already has the most lines
 *         { 2 }               the line would go over the most units
 */
export const ADD_SCRIPT = `
local delta = tonumber(ARGV[2])
local price = tonumber(ARGV[3])
local maxLines = tonumber(ARGV[4])
local maxQuantity = tonumber(ARGV[5])

local line = nil
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if raw then
  local ok, decoded = pcall(cjson.decode, raw)
  if ok and type(decoded) == 'table' and decoded.q then
    line = decoded
  end
end

if line then
  line.q = line.q + delta
  if line.q > maxQuantity then
    return {2}
  end
  line.p = price
else
  if redis.call('HLEN', KEYS[1]) >= maxLines and not raw then
    return {1}
  end
  if delta > maxQuantity then
    return {2}
  end
  local now = redis.call('TIME')
  line = {q = delta, p = price, t = now[1] * 1000 + math.floor(now[2] / 1000)}
end

redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(line))
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[6]))
return {0, line.q}
`;

/**
 * Sets the units of a line that already exists.
 *
 * KEYS[1]  the cart
 * ARGV[1]  sku id   ARGV[2]  the units   ARGV[3]  the price now, or '' to keep the recorded one
 * ARGV[4]  most units per line   ARGV[5]  time to live, in seconds
 *
 * Returns { 0, units, recorded price (text) }   done
 *         { 1 }                                 there is no such line
 *         { 2 }                                 over the most units
 */
export const SET_SCRIPT = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then
  return {1}
end
local ok, line = pcall(cjson.decode, raw)
if not ok or type(line) ~= 'table' or not line.q then
  return {1}
end

local quantity = tonumber(ARGV[2])
if quantity > tonumber(ARGV[4]) then
  return {2}
end

line.q = quantity
if ARGV[3] ~= '' then
  line.p = tonumber(ARGV[3])
end
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(line))
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
return {0, line.q, tostring(line.p)}
`;

/**
 * Removes a line. The time to live starts again only while lines remain (an empty hash is gone).
 *
 * KEYS[1]  the cart   ARGV[1]  sku id   ARGV[2]  time to live, in seconds
 */
export const REMOVE_SCRIPT = `
redis.call('HDEL', KEYS[1], ARGV[1])
if redis.call('HLEN', KEYS[1]) > 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return 0
`;

/**
 * Reads the whole cart in one step: { sku, json, sku, json, ... }. It does not renew the time to
 * live: only changes do.
 *
 * KEYS[1]  the cart
 */
export const READ_SCRIPT = `
return redis.call('HGETALL', KEYS[1])
`;
