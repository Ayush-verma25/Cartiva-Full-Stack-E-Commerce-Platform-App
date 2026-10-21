import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const subject = "c385b95f-26af-46fd-8570-46304d7380a8";
const issuer = "https://auth.example.test";
const audience = "cartiva";
const query = mock.fn(async () => []);
const findStore = mock.fn(async () => null);
mock.module("../dist/config/prisma.js", {
  namedExports: { prisma: { $queryRaw: query, stores: { findFirst: findStore } } },
});

const keys = await generateKeyPair("EdDSA");
const otherKeys = await generateKeyPair("ES256");
const jwks = { keys: [
  { ...await exportJWK(keys.publicKey), alg: "EdDSA", kid: "neon" },
  { ...await exportJWK(otherKeys.publicKey), alg: "ES256", kid: "other" },
] };
mock.method(globalThis, "fetch", async (url) => {
  assert.equal(String(url), `${issuer}/.well-known/jwks.json`);
  return Response.json(jwks);
});
process.env.NEON_AUTH_JWKS_URL = `${issuer}/.well-known/jwks.json`;
process.env.NEON_AUTH_BASE_URL = `${issuer}/auth`;
process.env.NEON_AUTH_AUDIENCE = audience;

const { optionalAuth, requireRole, verifyAuthToken } = await import("../dist/middleware/auth.js");
const { findNeonUser } = await import("../dist/services/neonUser.js");
delete process.env.NEON_AUTH_AUDIENCE;
const unconfiguredAuth = await import("../dist/middleware/auth.js?no-audience");
after(() => mock.restoreAll());
beforeEach(() => {
  query.mock.resetCalls();
  query.mock.mockImplementation(async () => []);
  findStore.mock.resetCalls();
  findStore.mock.mockImplementation(async () => null);
});

async function token(overrides = {}, alg = "EdDSA", privateKey = keys.privateKey) {
  const claims = {
    iss: issuer, aud: audience, sub: subject,
    exp: Math.floor(Date.now() / 1000) + 300,
    email: "customer@example.test", ...overrides,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg, kid: alg === "EdDSA" ? "neon" : "other" })
    .sign(privateKey);
}

test("valid token uses only sub for user and store identity", async () => {
  const user = await verifyAuthToken(await token({ id: "another-user" }));
  assert.equal(user.id, subject);
  assert.equal(user.role, "customer");
  assert.deepEqual(query.mock.calls[0].arguments.slice(1), [subject]);
  assert.deepEqual(findStore.mock.calls[0].arguments, [{ where: { merchant_id: subject } }]);
});

test("invalid claims and tokens are rejected before any database lookup", async (t) => {
  const cases = {
    "wrong audience": { aud: "another-service" },
    "missing audience": { aud: undefined },
    "wrong issuer": { iss: "https://another.example.test" },
    "missing issuer": { iss: undefined },
    "missing expiration": { exp: undefined },
    expired: { exp: Math.floor(Date.now() / 1000) - 60 },
    "email and id without sub": { sub: undefined, id: subject },
    "empty sub": { sub: "" },
    "non-UUID sub": { sub: "invalid-id" },
  };
  for (const [name, claims] of Object.entries(cases)) {
    await t.test(name, async () => assert.equal(await verifyAuthToken(await token(claims)), null));
  }
  assert.equal(await verifyAuthToken("malformed"), null);
  assert.equal(query.mock.callCount(), 0);
  assert.equal(findStore.mock.callCount(), 0);
});

test("rejects unapproved algorithm even when its key is in JWKS", async () => {
  assert.equal(await verifyAuthToken(await token({}, "ES256", otherKeys.privateKey)), null);
  assert.equal(query.mock.callCount(), 0);
});

test("rejects an invalid signature", async () => {
  const foreignKeys = await generateKeyPair("EdDSA");
  assert.equal(await verifyAuthToken(await token({}, "EdDSA", foreignKeys.privateKey)), null);
  assert.equal(query.mock.callCount(), 0);
});

test("missing audience configuration rejects authentication", async () => {
  assert.equal(await unconfiguredAuth.verifyAuthToken(await token()), null);
  assert.equal(query.mock.callCount(), 0);
});

test("admin-like email addresses do not grant admin access", async () => {
  assert.equal((await verifyAuthToken(await token({ email: "admin@example.test" }))).role, "customer");
  query.mock.mockImplementation(async () => [{ id: subject, email: "admin@example.test" }]);
  assert.equal((await verifyAuthToken(await token())).role, "customer");
});

test("trusted roles and store ownership preserve role assignment", async () => {
  assert.equal((await verifyAuthToken(await token({ role: "admin" }))).role, "admin");
  query.mock.mockImplementation(async () => [{ id: subject, role: "admin" }]);
  assert.equal((await verifyAuthToken(await token())).role, "admin");
  query.mock.mockImplementation(async () => []);
  assert.equal((await verifyAuthToken(await token({ role: "merchant" }))).role, "merchant");
  findStore.mock.mockImplementation(async () => ({ id: 42 }));
  const merchant = await verifyAuthToken(await token());
  assert.equal(merchant.role, "merchant");
  assert.equal(merchant.store_id, 42);
});

test("optionalAuth trims Bearer whitespace and continues for invalid tokens", async () => {
  const signed = await token();
  for (const header of [`Bearer ${signed}`, `Bearer    ${signed}  `, "Bearer invalid", "Bearer   ", undefined]) {
    const req = { headers: { authorization: header } };
    const next = mock.fn();
    await optionalAuth(req, {}, next);
    assert.equal(req.user?.id, header?.includes(signed) ? subject : undefined);
    assert.equal(next.mock.callCount(), 1);
  }
});

test("requireRole immediately returns middleware that allows or denies access", () => {
  const middleware = requireRole(["admin"]);
  assert.equal(typeof middleware, "function");
  const next = mock.fn();
  const res = { status: mock.fn(() => res), json: mock.fn() };
  middleware({ user: { role: "admin" } }, res, next);
  assert.equal(next.mock.callCount(), 1);
  for (const req of [{}, { user: { role: "customer" } }]) {
    middleware(req, res, next);
  }
  assert.equal(next.mock.callCount(), 1);
  assert.equal(res.status.mock.callCount(), 2);
  assert.deepEqual(res.status.mock.calls[0].arguments, [403]);
  assert.deepEqual(res.json.mock.calls[0].arguments, [{ success: false, message: "Forbidden: Access denied" }]);
});

test("user lookup returns records or null and normalizes email", async () => {
  const record = { id: subject, name: "Customer", email: "customer@example.test", role: null, createdAt: new Date() };
  query.mock.mockImplementation(async () => [record]);
  assert.equal(await findNeonUser({ id: subject }), record);
  await findNeonUser({ email: "  CUSTOMER@EXAMPLE.TEST  " });
  assert.deepEqual(query.mock.calls[1].arguments.slice(1), ["customer@example.test"]);
  query.mock.mockImplementation(async () => []);
  assert.equal(await findNeonUser({ id: subject }), null);
  assert.equal(await findNeonUser({ email: "missing@example.test" }), null);
});

test("user lookup rejects invalid UUIDs without querying", async () => {
  await assert.rejects(findNeonUser({ id: "invalid-id", email: "customer@example.test" }), /Invalid Neon user UUID/);
  assert.equal(query.mock.callCount(), 0);
});

test("lookup failures propagate and cause authentication rejection", async () => {
  const failure = new Error("database unavailable");
  query.mock.mockImplementation(async () => { throw failure; });
  await assert.rejects(findNeonUser({ id: subject }), (error) => error === failure);
  await assert.rejects(findNeonUser({ email: "customer@example.test" }), (error) => error === failure);
  assert.equal(await verifyAuthToken(await token()), null);
  assert.equal(findStore.mock.callCount(), 0);
});
