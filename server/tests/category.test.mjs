import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";

const merchantId = "c385b95f-26af-46fd-8570-46304d7380a8";
const stores = [
  { id: 11, merchant_id: merchantId },
  { id: 22, merchant_id: merchantId },
  { id: 33, merchant_id: "another-merchant" },
];
const findStore = mock.fn();
const findStoreBySlug = mock.fn();
const findCategories = mock.fn();
const createCategory = mock.fn();
const deleteCategoriesQuery = mock.fn();
const queries = [findStore, findStoreBySlug, findCategories, createCategory, deleteCategoriesQuery];
mock.module("../dist/config/prisma.js", {
  namedExports: {
    prisma: {
      stores: { findFirst: findStore, findUnique: findStoreBySlug },
      categories: {
        findMany: findCategories,
        create: createCategory,
        deleteMany: deleteCategoriesQuery,
      },
    },
  },
});
const { getCategories, createCategories, deleteCategories } = await import("../dist/controllers/categoryController.js");
after(() => mock.restoreAll());
beforeEach(() => {
  for (const query of queries) query.mock.resetCalls();
  findStore.mock.mockImplementation(async ({ where }) =>
    stores.find((store) => Object.entries(where).every(([key, value]) => store[key] === value)) ?? null);
  findStoreBySlug.mock.mockImplementation(async () => ({ id: 22 }));
  findCategories.mock.mockImplementation(async () => [{ id: 7, name: "Books", _count: { products: 3 } }]);
  createCategory.mock.mockImplementation(async ({ data }) => ({ id: 7, ...data }));
  deleteCategoriesQuery.mock.mockImplementation(async () => ({ count: 1 }));
});

async function invoke(handler, request = {}) {
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ query: {}, params: {}, user: { id: merchantId }, ...request }, res);
  return res;
}

function assertNoQueries() {
  for (const query of queries) assert.equal(query.mock.callCount(), 0);
}

test("creation targets the requested store among multiple merchant stores and preserves name handling", async () => {
  const res = await invoke(createCategories, { body: { storeId: "22", name: "  Home & Garden  " } });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(findStore.mock.calls[0].arguments, [{ where: { id: 22, merchant_id: merchantId } }]);
  assert.deepEqual(createCategory.mock.calls[0].arguments, [{
    data: { store_id: 22, name: "Home & Garden", slug: "home--garden" },
  }]);
  assert.equal(res.body.category.store_id, 22);
});

test("deletion scopes both the requested category and merchant store", async () => {
  const res = await invoke(deleteCategories, { query: { storeId: "22" }, params: { id: "7" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(findStore.mock.calls[0].arguments, [{ where: { id: 22, merchant_id: merchantId } }]);
  assert.deepEqual(deleteCategoriesQuery.mock.calls[0].arguments, [{ where: { id: 7, store_id: 22 } }]);
});

test("writes reject another merchant's store and nonexistent stores without mutations", async () => {
  for (const storeId of [33, 44]) {
    for (const [handler, request] of [
      [createCategories, { body: { storeId, name: "Books" } }],
      [deleteCategories, { query: { storeId: String(storeId) }, params: { id: "7" } }],
    ]) {
      const res = await invoke(handler, request);
      assert.equal(res.statusCode, 404);
      assert.deepEqual(res.body, { success: false, message: "Store not found" });
    }
  }
  assert.equal(createCategory.mock.callCount(), 0);
  assert.equal(deleteCategoriesQuery.mock.callCount(), 0);
});

const invalidIds = [
  undefined, null, "", " ", "invalid", Infinity, "Infinity", NaN, "NaN",
  0, "0", -1, "-1", 1.5, "1.5", 2_147_483_648, "2147483648",
  Number.MAX_SAFE_INTEGER, true, false, [], ["22"], {}, { id: 22 },
];

test("invalid store IDs return 400 before any query in every handler", async () => {
  for (const storeId of invalidIds) {
    const requests = [
      [getCategories, { query: { storeId } }],
      [createCategories, { body: { storeId, name: "Books" } }],
      [deleteCategories, { query: { storeId }, params: { id: "7" } }],
    ];
    if (storeId !== undefined) {
      requests.push([getCategories, { query: { storeId, storeSlug: "books" } }]);
    }
    for (const [handler, request] of requests) {
      const res = await invoke(handler, request);
      assert.equal(res.statusCode, 400, `${handler.name}: ${String(storeId)}`);
      assert.equal(res.body.success, false);
      assertNoQueries();
    }
  }
});

test("invalid category IDs are rejected before the store lookup or deletion", async () => {
  for (const id of invalidIds) {
    const res = await invoke(deleteCategories, { query: { storeId: "22" }, params: { id } });
    assert.equal(res.statusCode, 400, String(id));
    assert.equal(res.body.success, false);
    assertNoQueries();
  }
});

test("missing, blank, and non-string names return the existing validation response", async () => {
  for (const name of [undefined, null, "", " \t\n ", 123, false, [], {}, ["Books"]]) {
    const res = await invoke(createCategories, { body: { storeId: 22, name } });
    assert.equal(res.statusCode, 400, String(name));
    assert.deepEqual(res.body, { success: false, message: "Category name is required" });
    assertNoQueries();
  }
});

test("missing creation body returns 400 without querying", async () => {
  const res = await invoke(createCategories);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assertNoQueries();
});

test("positive signed 32-bit ID boundaries are accepted as strings and numbers", async () => {
  findStore.mock.mockImplementation(async ({ where }) => ({ id: where.id }));
  for (const id of [1, "1", 2_147_483_647, "2147483647"]) {
    const numericId = Number(id);
    const listing = await invoke(getCategories, { query: { storeId: id } });
    assert.equal(listing.statusCode, 200);
    assert.equal(findCategories.mock.calls.at(-1).arguments[0].where.store_id, numericId);

    const creation = await invoke(createCategories, { body: { storeId: id, name: "Books" } });
    assert.equal(creation.statusCode, 201);
    assert.equal(createCategory.mock.calls.at(-1).arguments[0].data.store_id, numericId);

    const deletion = await invoke(deleteCategories, { query: { storeId: id }, params: { id } });
    assert.equal(deletion.statusCode, 200);
    assert.deepEqual(deleteCategoriesQuery.mock.calls.at(-1).arguments, [{
      where: { id: numericId, store_id: numericId },
    }]);
  }
});

test("listing by slug retains precedence and product counts", async () => {
  for (const query of [{ storeSlug: "books" }, { storeId: "11", storeSlug: "books" }]) {
    const res = await invoke(getCategories, { query });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, categories: [{ id: 7, name: "Books", product_count: 3 }] });
    assert.deepEqual(findStoreBySlug.mock.calls.at(-1).arguments, [{ where: { slug: "books" }, select: { id: true } }]);
    assert.equal(findCategories.mock.calls.at(-1).arguments[0].where.store_id, 22);
  }
});

test("non-string store slugs return 400 before the store lookup", async () => {
  for (const storeSlug of [null, 123, [], ["books"], {}]) {
    const res = await invoke(getCategories, { query: { storeSlug } });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, { success: false, message: "Invalid store slug" });
    assertNoQueries();
  }
});

test("listing with a missing store slug returns 404 without fetching categories", async () => {
  findStoreBySlug.mock.mockImplementation(async () => null);
  const res = await invoke(getCategories, { query: { storeSlug: "missing" } });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { success: false, message: "Store not found" });
  assert.equal(findCategories.mock.callCount(), 0);
});
