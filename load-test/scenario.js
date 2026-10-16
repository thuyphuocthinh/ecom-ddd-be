// Load test of the storefront API, as three kinds of visitors at the same time (k6).
//
//   browse    guests: home, search, category, price sort, product page, facets   (the busiest crowd)
//   shoppers  signed-in users: cart, then place an order (cash on delivery), then look at it
//   account   signed-in users: order list, counts, order detail, payments, addresses
//   flash     (PROFILE=flash) a flash sale: 100 users fight for the last units of ONE product
//
// Every visitor thinks between actions (a person does not click 100 times a second), and each
// signed-in virtual user is a different user, because the API limits each user to 60 reads and
// 10 order writes a minute.
//
// Run (see README.md):   k6 run -e PROFILE=smoke load-test/scenario.js
// Profiles: smoke (1 min, a quick check), load (5 min, a normal busy day), stress (8 min, find the limit),
//           flash (the flash sale only)
import http from "k6/http";
import exec from "k6/execution";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import { Counter } from "k6/metrics";

const BASE = __ENV.BASE || "http://localhost:4100/api/v1";
const PROFILE = __ENV.PROFILE || "smoke";
const FLASH_SKU = __ENV.FLASH_SKU || "seed_sku_flash";
const RUN = __ENV.RUN_ID || String(Date.now());

const users = new SharedArray("users", () => JSON.parse(open("./users.json")));

// Each signed-in virtual user is a different user (virtual user numbers are unique in the whole test), so
// users.json must hold at least as many users as there are virtual users: USERS=300 is enough for smoke
// and load, USERS=800 for stress (node load-test/prepare.mjs).
const userOfThisVu = () => users[exec.vu.idInTest % users.length];

// ---- how many virtual users, per profile ------------------------------------------------------
const ramp = (steps) => steps.map(([duration, target]) => ({ duration, target }));
const PROFILES = {
  smoke: {
    browse: ramp([["20s", 5], ["30s", 5], ["10s", 0]]),
    shoppers: ramp([["20s", 2], ["30s", 2], ["10s", 0]]),
    account: ramp([["20s", 2], ["30s", 2], ["10s", 0]]),
  },
  load: {
    browse: ramp([["1m", 100], ["3m", 100], ["30s", 0]]),
    shoppers: ramp([["1m", 50], ["3m", 50], ["30s", 0]]),
    account: ramp([["1m", 40], ["3m", 40], ["30s", 0]]),
  },
  stress: {
    browse: ramp([["1m", 100], ["2m", 250], ["2m", 400], ["2m", 400], ["30s", 0]]),
    shoppers: ramp([["1m", 40], ["2m", 100], ["2m", 150], ["2m", 150], ["30s", 0]]),
    account: ramp([["1m", 40], ["2m", 100], ["2m", 140], ["2m", 140], ["30s", 0]]),
  },
};

function scenarios() {
  if (PROFILE === "flash") {
    return {
      flash: { executor: "per-vu-iterations", vus: 100, iterations: 1, maxDuration: "2m", exec: "flash" },
    };
  }
  const p = PROFILES[PROFILE];
  if (!p) throw new Error(`Unknown PROFILE "${PROFILE}": smoke, load, stress or flash`);
  const rampingVus = (stages, fn) => ({ executor: "ramping-vus", startVUs: 0, stages, gracefulRampDown: "20s", exec: fn });
  return {
    browse: rampingVus(p.browse, "browse"),
    shoppers: rampingVus(p.shoppers, "shopper"),
    account: rampingVus(p.account, "account"),
  };
}

// 409 is an expected answer for an order (a product that sold out), so it is not counted as a failure
const okOrSoldOut = http.expectedStatuses({ min: 200, max: 299 }, 409);

export const options = {
  scenarios: scenarios(),
  thresholds: {
    // Fewer than 1 request in 100 may fail (a failure is a 4xx or 5xx that is not expected)
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
    // What a customer feels, per kind of visitor
    "http_req_duration{scenario:browse}": ["p(95)<400", "p(99)<1000"],
    "http_req_duration{scenario:shoppers}": ["p(95)<800", "p(99)<1500"],
    "http_req_duration{scenario:account}": ["p(95)<300", "p(99)<800"],
    // Nobody may be told to slow down: the pacing of the test must stay under the API's own limits
    rate_limited: ["count==0"],
    // A flash sale never sells what it does not have
    flash_unexpected: ["count==0"],
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
};

// k6 only keeps a per-endpoint line in the report for tags that a threshold mentions, so every endpoint
// gets one that never fails (max >= 0): it is there for the report, not as a limit.
const ENDPOINT_NAMES = [
  "GET /catalog/categories", "GET /catalog/products - newest", "GET /catalog/products - search",
  "GET /catalog/products - category", "GET /catalog/products - price sort", "GET /catalog/products/:id",
  "GET /catalog/products/facets", "GET /users/me", "GET /cart", "POST /cart/items", "GET /cart - after adding",
  "POST /orders", "GET /orders/:id", "DELETE /cart", "GET /orders", "GET /orders/counts", "GET /orders - filtered",
  "GET /users/me/addresses", "GET /orders/:id/payments", "POST /cart/items - flash", "POST /orders - flash",
  "POST /orders - flash retry",
];
for (const name of ENDPOINT_NAMES) options.thresholds[`http_req_duration{name:${name}}`] = ["max>=0"];

const rateLimited = new Counter("rate_limited");
const flashCreated = new Counter("flash_created");
const flashSoldOut = new Counter("flash_sold_out");
const flashUnexpected = new Counter("flash_unexpected");
const ordersPlaced = new Counter("orders_placed");

// ---- helpers ----------------------------------------------------------------------------------
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (low, high) => low + Math.random() * (high - low);
const think = (low, high) => sleep(between(low, high));
const uniqueKey = (label) => `${label}-${RUN}-${exec.vu.idInTest}-${exec.vu.iterationInScenario}`.slice(0, 100);

function authHeaders(user, extra = {}) {
  return { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json", ...extra };
}

/** GET with a stable name, so /products/<id> is one line in the report and not 3,000. */
function get(path, name, params = {}) {
  const res = http.get(`${BASE}${path}`, { ...params, tags: { name, ...(params.tags || {}) } });
  if (res.status === 429) rateLimited.add(1);
  return res;
}

function json(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

// ---- data the visitors browse (read once, before the test) --------------------------------------
export function setup() {
  const products = [];
  for (let page = 1; page <= 6; page++) {
    const res = http.get(`${BASE}/catalog/products?limit=50&page=${page}`, { tags: { name: "setup" } });
    const body = json(res);
    for (const product of (body && body.data) || []) {
      const sku = (product.skus || []).find((item) => item.inStock);
      if (sku) products.push({ id: product.id, skuId: sku.id });
    }
  }
  if (products.length < 20) throw new Error("The catalog is almost empty: run scripts/seed-catalog.sql and seed-stock.sql first");
  return { products };
}

const SEARCHES = ["điện thoại", "máy tính", "áo thun", "giày", "đèn bàn", "tiểu thuyết", "iphone", "cotton"];
const LEAF_CATEGORIES = ["seed_cat_phones", "seed_cat_laptops", "seed_cat_tshirts", "seed_cat_shoes", "seed_cat_home", "seed_cat_books"];
const SORTS = ["price_asc", "price_desc", "newest"];

// ---- scenario 1: guests browsing ----------------------------------------------------------------
export function browse(data) {
  const roll = Math.random() * 100;
  if (roll < 25) {
    // The home page: the categories and the newest products
    const a = get("/catalog/categories", "GET /catalog/categories");
    const b = get("/catalog/products?limit=20", "GET /catalog/products - newest");
    check(a, { "categories 200": (r) => r.status === 200 });
    check(b, { "newest 200": (r) => r.status === 200 });
  } else if (roll < 50) {
    const term = encodeURIComponent(pick(SEARCHES));
    const sort = Math.random() < 0.5 ? "relevance" : pick(SORTS);
    const page = 1 + Math.floor(Math.random() * 3);
    const res = get(`/catalog/products?search=${term}&sort=${sort}&page=${page}&limit=20`, "GET /catalog/products - search");
    check(res, { "search 200": (r) => r.status === 200 });
  } else if (roll < 65) {
    const res = get(`/catalog/products?categoryId=${pick(LEAF_CATEGORIES)}&page=${1 + Math.floor(Math.random() * 3)}&limit=20`, "GET /catalog/products - category");
    check(res, { "category 200": (r) => r.status === 200 });
  } else if (roll < 75) {
    const res = get(`/catalog/products?sort=${pick(["price_asc", "price_desc"])}&page=${1 + Math.floor(Math.random() * 5)}&limit=20&inStock=true`, "GET /catalog/products - price sort");
    check(res, { "price sort 200": (r) => r.status === 200 });
  } else if (roll < 95) {
    const res = get(`/catalog/products/${pick(data.products).id}`, "GET /catalog/products/:id");
    check(res, { "product 200": (r) => r.status === 200 });
  } else {
    const res = get("/catalog/products/facets", "GET /catalog/products/facets");
    check(res, { "facets 200": (r) => r.status === 200 });
  }
  think(1, 3);
}

// ---- scenario 2: shoppers fill a cart and place a cash-on-delivery order -------------------------
export function shopper(data) {
  const user = userOfThisVu();
  const headers = authHeaders(user);
  const named = (name) => ({ headers, tags: { name } });

  check(http.get(`${BASE}/users/me`, named("GET /users/me")), { "me 200": (r) => r.status === 200 });
  check(http.get(`${BASE}/cart`, named("GET /cart")), { "cart 200": (r) => r.status === 200 });
  think(1, 2);

  for (let i = 0; i < 1 + Math.floor(Math.random() * 2); i++) {
    const res = http.post(`${BASE}/cart/items`, JSON.stringify({ skuId: pick(data.products).skuId, quantity: 1 + Math.floor(Math.random() * 2) }), named("POST /cart/items"));
    if (res.status === 429) rateLimited.add(1);
    check(res, { "add to cart 2xx": (r) => r.status >= 200 && r.status < 300 });
    think(0.5, 1.5);
  }
  check(http.get(`${BASE}/cart`, named("GET /cart - after adding")), { "cart 200 after adding": (r) => r.status === 200 });
  think(1, 3);

  const order = http.post(`${BASE}/orders`, JSON.stringify({ addressId: user.addressId, paymentMethod: "COD" }), {
    headers: authHeaders(user, { "Idempotency-Key": uniqueKey("shop") }),
    tags: { name: "POST /orders" },
    responseCallback: okOrSoldOut,
  });
  if (order.status === 429) rateLimited.add(1);
  const placed = order.status === 201;
  check(order, { "order placed (or sold out)": (r) => r.status === 201 || r.status === 409 });
  if (placed) {
    ordersPlaced.add(1);
    const created = json(order);
    const id = created && created.data && created.data.id;
    if (id) check(http.get(`${BASE}/orders/${id}`, named("GET /orders/:id")), { "order detail 200": (r) => r.status === 200 });
  } else {
    // The order did not go through, so the items are still in the cart: empty it, like a person would
    http.del(`${BASE}/cart`, null, named("DELETE /cart"));
  }
  think(7, 10); // at most 10 order writes a minute per user
}

// ---- scenario 3: people looking at their account --------------------------------------------------
export function account() {
  const user = userOfThisVu();
  const headers = authHeaders(user);
  const named = (name) => ({ headers, tags: { name } });

  const list = http.get(`${BASE}/orders?limit=20`, named("GET /orders"));
  check(list, { "orders 200": (r) => r.status === 200 });
  check(http.get(`${BASE}/orders/counts`, named("GET /orders/counts")), { "counts 200": (r) => r.status === 200 });
  if (Math.random() < 0.4) check(http.get(`${BASE}/orders?status=DELIVERED,SHIPPING&limit=20`, named("GET /orders - filtered")), { "filtered 200": (r) => r.status === 200 });
  check(http.get(`${BASE}/users/me/addresses`, named("GET /users/me/addresses")), { "addresses 200": (r) => r.status === 200 });
  const orders = (json(list) || {}).data || [];
  if (orders.length > 0) {
    const id = pick(orders).id;
    check(http.get(`${BASE}/orders/${id}`, named("GET /orders/:id")), { "order detail 200": (r) => r.status === 200 });
    if (Math.random() < 0.3) http.get(`${BASE}/orders/${id}/payments`, named("GET /orders/:id/payments"));
  }
  think(6, 10); // at most 60 reads a minute per user
}

// ---- scenario 4: a flash sale -----------------------------------------------------------------------
// 100 different users add the flash product to the cart at once and place an order with the same
// timing. The stock is small, so most must be told "sold out" (409), and the ones who got it must
// never exceed the stock. After the run, check the database (README.md, "Flash sale").
export function flash() {
  const user = userOfThisVu();
  const headers = authHeaders(user);
  const named = (name, extra = {}) => ({ headers, tags: { name }, responseCallback: okOrSoldOut, ...extra });

  http.del(`${BASE}/cart`, null, named("DELETE /cart"));
  const added = http.post(`${BASE}/cart/items`, JSON.stringify({ skuId: FLASH_SKU, quantity: 1 }), named("POST /cart/items - flash"));
  if (added.status < 200 || added.status >= 300) {
    flashUnexpected.add(1);
    return;
  }

  const key = uniqueKey("flash");
  const body = JSON.stringify({ addressId: user.addressId, paymentMethod: "COD" });
  const first = http.post(`${BASE}/orders`, body, named("POST /orders - flash", { headers: authHeaders(user, { "Idempotency-Key": key }) }));

  if (first.status === 201) flashCreated.add(1);
  else if (first.status === 409) flashSoldOut.add(1);
  else flashUnexpected.add(1);

  // The customer presses "order" again (a retry): the same key must answer the same way, and never make a second order
  const again = http.post(`${BASE}/orders`, body, named("POST /orders - flash retry", { headers: authHeaders(user, { "Idempotency-Key": key }) }));
  check(again, {
    "retry with the same key gives the same answer": (r) => (first.status === 201 ? r.status === 200 && r.headers["Idempotency-Replayed"] === "true" : r.status === first.status),
  });
  if (first.status === 201) {
    const id = json(first).data.id;
    const replayed = json(again);
    check(again, { "retry returns the same order": () => replayed && replayed.data && replayed.data.id === id });
  }
}

// ---- the report -----------------------------------------------------------------------------------
export function handleSummary(data) {
  const lines = [];
  const metric = (name) => data.metrics[`http_req_duration{name:${name}}`];
  lines.push(`PROFILE=${PROFILE}  requests=${data.metrics.http_reqs.values.count}  rps=${data.metrics.http_reqs.values.rate.toFixed(1)}  failed=${(data.metrics.http_req_failed.values.rate * 100).toFixed(2)}%`);
  const all = data.metrics.http_req_duration.values;
  lines.push(`ALL requests   avg=${all.avg.toFixed(0)}ms  med=${all.med.toFixed(0)}ms  p95=${all["p(95)"].toFixed(0)}ms  p99=${all["p(99)"].toFixed(0)}ms  max=${all.max.toFixed(0)}ms`);
  lines.push("");
  const names = Object.keys(data.metrics)
    .filter((key) => key.startsWith("http_req_duration{name:") && !key.includes("setup"))
    .map((key) => key.slice("http_req_duration{name:".length, -1))
    .sort();
  lines.push("endpoint".padEnd(46) + "med".padStart(8) + "p95".padStart(8) + "p99".padStart(8) + "max".padStart(8));
  for (const name of names) {
    const v = metric(name).values;
    if (!v || v.med === undefined) continue;
    lines.push(name.padEnd(46) + `${v.med.toFixed(0)}ms`.padStart(8) + `${v["p(95)"].toFixed(0)}ms`.padStart(8) + `${v["p(99)"].toFixed(0)}ms`.padStart(8) + `${v.max.toFixed(0)}ms`.padStart(8));
  }
  const counter = (name) => (data.metrics[name] ? data.metrics[name].values.count : 0);
  lines.push("");
  lines.push(`orders placed=${counter("orders_placed")}  rate limited=${counter("rate_limited")}  flash: created=${counter("flash_created")} sold out=${counter("flash_sold_out")} unexpected=${counter("flash_unexpected")}`);
  const failed = Object.entries(data.metrics).filter(([, m]) => m.thresholds && Object.values(m.thresholds).some((t) => !t.ok)).map(([k]) => k);
  lines.push(failed.length ? `THRESHOLDS FAILED: ${failed.join(", ")}` : "ALL THRESHOLDS PASSED");
  return { stdout: lines.join("\n") + "\n", [`load-test/result-${PROFILE}.json`]: JSON.stringify(data) };
}
