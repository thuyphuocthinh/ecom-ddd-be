// Prepares the users a load test logs in as, WITHOUT going through POST /auth/login (it allows only
// 5 tries per 15 minutes per IP, and a load test comes from one IP).
//
// For each load user it inserts a user and an address into the load-test database, and writes
// users.json with a ready access token (signed with the app's own JWT_ACCESS_SECRET, like the
// login would). The tokens work only against an app that uses the same secret.
//
//   node load-test/prepare.mjs                 (database ecom_load, 300 users)
//   LOAD_DB=ecom_load USERS=500 node load-test/prepare.mjs
//
// It refuses to touch ecom_db: load users belong in a COPY of the database (see README.md).
import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const database = process.env.LOAD_DB ?? "ecom_load";
const count = Number(process.env.USERS ?? 300);
const container = process.env.PG_CONTAINER ?? "ecom_postgres";

if (database === "ecom_db" || !/^[a-z0-9_]+$/.test(database)) {
  console.error(`Refusing to write load users into "${database}". Use a copy: LOAD_DB=ecom_load`);
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1).replace(/^"|"$/g, "")];
    }),
);
const secret = process.env.JWT_ACCESS_SECRET ?? env.JWT_ACCESS_SECRET;
if (!secret) {
  console.error("JWT_ACCESS_SECRET is not set in .env");
  process.exit(1);
}

const base64url = (value) => Buffer.from(value).toString("base64url");
function sign(payload) {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

// One valid province and ward to copy: the ones of an existing address
function psql(sql) {
  const run = spawnSync("docker", ["exec", "-i", container, "psql", "-U", "root", "-d", database, "-v", "ON_ERROR_STOP=1", "-tA"], {
    input: sql,
    encoding: "utf8",
  });
  if (run.status !== 0) {
    console.error(run.stderr || run.stdout);
    process.exit(1);
  }
  return run.stdout.trim();
}

const place = psql(`SELECT "provinceCode" || '|' || "provinceName" || '|' || "wardCode" || '|' || "wardName" FROM "Address" LIMIT 1`);
if (!place) {
  console.error("The database has no address to copy the province and ward from");
  process.exit(1);
}
const [provinceCode, provinceName, wardCode, wardName] = place.split("|");

// Ids are made from the number, so running again does not make duplicates
const uuid = (kind, expression) => `md5('load-${kind}-' || ${expression})::uuid::text`;
psql(`
INSERT INTO "User" ("id", "displayName", "role", "status", "createdAt", "updatedAt")
SELECT ${uuid("user", "i")}, 'Load User ' || i, 'CUSTOMER', 'ACTIVE', now(), now() FROM generate_series(1, ${count}) i
ON CONFLICT ("id") DO NOTHING;
INSERT INTO "Address" ("id", "userId", "recipientName", "phone", "provinceCode", "provinceName", "wardCode", "wardName",
                       "street", "label", "isDefault", "createdAt", "updatedAt")
SELECT ${uuid("address", "i")}, ${uuid("user", "i")}, 'Load User ' || i, '0900000000', '${provinceCode}', '${provinceName}',
       '${wardCode}', '${wardName}', i || ' Duong Thu', 'Nha', true, now(), now()
FROM generate_series(1, ${count}) i
ON CONFLICT ("id") DO NOTHING;
`);

const ids = psql(`SELECT ${uuid("user", "i")} || '|' || ${uuid("address", "i")} FROM generate_series(1, ${count}) i`)
  .split(/\r?\n/)
  .map((line) => line.split("|"));

const now = Math.floor(Date.now() / 1000);
const users = ids.map(([userId, addressId], index) => ({
  userId,
  addressId,
  token: sign({ sub: userId, role: "CUSTOMER", ver: 0, sid: `load-session-${index + 1}`, iat: now, exp: now + 3 * 3600 }),
}));
writeFileSync(new URL("./users.json", import.meta.url), JSON.stringify(users));
console.log(`${users.length} load users ready in ${database}; tokens valid for 3 hours -> load-test/users.json`);
