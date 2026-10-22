import assert from "node:assert/strict";
import { once } from "node:events";
import { after, beforeEach, mock, test } from "node:test";
import express from "express";

const userId = "c385b95f-26af-46fd-8570-46304d7380a8";
const events = [];
const findStore = mock.fn();
const findSlug = mock.fn();
const create = mock.fn();
const findStores = mock.fn();
const execute = mock.fn();
const query = mock.fn();
const logError = mock.method(console, "error", () => {});
const queries = [findStore, findSlug, create, findStores, execute, query];
mock.module("../dist/config/prisma.js", {
  namedExports: {
    prisma: {
      stores: { findFirst: findStore, findUnique: findSlug, create, findMany: findStores },
      $executeRaw: execute,
      $queryRaw: query,
    },
  },
});
// Authentication is synthetic; routing and the Neon service implementations are real.
mock.module("../dist/middleware/auth.js", {
  namedExports: {
    requireAuth(req, res, next) {
      const role = req.get("x-test-role");
      if (!role) return res.status(401).json({ success: false });
      req.user = { id: userId, role };
      next();
    },
    requireRole: (roles) => (req, res, next) => roles.includes(req.user.role)
      ? next() : res.status(403).json({ success: false }),
  },
});
const { createStore, getAllMerchants, getMyStore } = await import("../dist/controllers/storeController.js");
const { findNeonMerchants, updateNeonUserRole } = await import("../dist/services/neonUser.js");
const { default: storeRouter } = await import("../dist/routes/storeRoutes.js");
after(() => mock.restoreAll());
beforeEach(() => {
  for (const fn of [...queries, logError]) fn.mock.resetCalls();
  events.length = 0;
  findStore.mock.mockImplementation(async () => null);
  findSlug.mock.mockImplementation(async () => null);
  create.mock.mockImplementation(async ({ data }) => {
    events.push("store");
    return { id: 11, ...data };
  });
  findStores.mock.mockImplementation(async () => []);
  execute.mock.mockImplementation(async () => { events.push("role"); return 1; });
  query.mock.mockImplementation(async () => []);
});

async function invoke(handler, request = {}) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ user: { id: userId, role: "customer" }, body: { name: "Book Shop" }, ...request }, res);
  return res;
}

test("empty normalized slugs return 400 before uniqueness checks or mutations", async () => {
  for (const body of [
    { name: "   " }, { name: "!!!" }, { name: "商店" },
    { name: "Book Shop", slug: "!!!" }, { name: "Book Shop", slug: "   " },
  ]) {
    const res = await invoke(createStore, { body });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.success, false);
    for (const fn of [findSlug, execute, create]) assert.equal(fn.mock.callCount(), 0);
  }
});

test("store creation normalizes the slug and awaits the role update before inserting", async () => {
  const res = await invoke(createStore);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.store.slug, "book-shop");
  assert.deepEqual(events, ["role", "store"]);
  assert.deepEqual(execute.mock.calls[0].arguments.slice(1), ["merchant", userId]);
});

test("Neon role update errors are logged, rethrown, and prevent store creation", async () => {
  const failure = new Error("synthetic role update failure");
  execute.mock.mockImplementation(async () => { throw failure; });
  await assert.rejects(updateNeonUserRole(userId, "merchant"), (error) => error === failure);
  assert.deepEqual(logError.mock.calls[0].arguments, [failure]);
  const res = await invoke(createStore);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.success, false);
  assert.equal(create.mock.callCount(), 0);
});

test("getMyStore denies admins and preserves the existing forbidden response", async () => {
  const res = await invoke(getMyStore, { user: { id: userId, role: "admin" } });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, {
    success: false,
    message: "Forbidden: Platform admin do not manage merchant stores",
  });
  assert.equal(findStore.mock.callCount(), 0);
});

test("merchants and customers can look up their own store, including when none exists", async () => {
  for (const role of ["merchant", "customer"]) {
    for (const store of [null, { id: 11, merchant_id: userId }]) {
      findStore.mock.mockImplementation(async () => store);
      const res = await invoke(getMyStore, { user: { id: userId, role } });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body, { success: true, store });
      assert.deepEqual(findStore.mock.calls.at(-1).arguments, [{ where: { merchant_id: userId } }]);
    }
  }
});

test("merchant query errors are logged and propagated to the admin controller", async () => {
  const failure = new Error("synthetic merchant query failure");
  query.mock.mockImplementation(async () => { throw failure; });
  await assert.rejects(findNeonMerchants(), (error) => error === failure);
  assert.deepEqual(logError.mock.calls[0].arguments, [failure]);
  const res = await invoke(getAllMerchants);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.success, false);
  assert.equal(findStores.mock.callCount(), 0);
});

test("an empty merchant result is still a successful empty list", async () => {
  const res = await invoke(getAllMerchants);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, merchants: [] });
});

test("GET /api/stores/admin/all reaches the controller and retains authentication and role guards", async () => {
  const app = express();
  app.use("/api/stores", storeRouter);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/api/stores/admin/all`;
    for (const [role, expected] of [[null, 401], ["customer", 403], ["merchant", 403], ["admin", 200]]) {
      const res = await fetch(url, { headers: role ? { "x-test-role": role } : {} });
      assert.equal(res.status, expected);
      const body = await res.json();
      if (role === "admin") assert.deepEqual(body, { success: true, stores: [] });
    }
    assert.equal(findStores.mock.callCount(), 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
