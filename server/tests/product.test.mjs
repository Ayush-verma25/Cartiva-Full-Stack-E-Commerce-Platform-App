import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";

const findStore = mock.fn(async () => ({ id: 11 }));
const findProduct = mock.fn(async () => ({ id: 7, store_id: 11 }));
const create = mock.fn(async ({ data }) => ({ id: 7, ...data }));
const update = mock.fn(async ({ data }) => ({ id: 7, ...data }));
const queries = [findStore, findProduct, create, update];
mock.module("../dist/config/prisma.js", {
  namedExports: {
    prisma: {
      stores: { findFirst: findStore },
      products: { findFirst: findProduct, create, update },
    },
  },
});
const { createProduct, updateProduct } = await import("../dist/controllers/productController.js");
after(() => mock.restoreAll());
beforeEach(() => {
  for (const query of queries) query.mock.resetCalls();
});

async function invoke(handler, body) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ user: { id: "merchant" }, params: { id: "7" }, body }, res);
  return res;
}

const invalidValues = {
  name: [null, "", " \t\n", 123, true, [], {}],
  price: [null, "", " ", -1, "-1", NaN, Infinity, -Infinity, "Infinity", "NaN", "bad", true, false, [], [1], {}],
  stock: [null, "", " ", -1, "-1", 1.5, "1.5", NaN, Infinity, "Infinity", "NaN", "bad", true, false, [], [1], {}],
};

test("invalid supplied product fields return 400 without database access on create and update", async () => {
  for (const [field, values] of Object.entries(invalidValues)) {
    for (const value of values) {
      for (const handler of [createProduct, updateProduct]) {
        const body = handler === createProduct ? { name: "Book", price: 10 } : {};
        const res = await invoke(handler, { ...body, [field]: value });
        assert.equal(res.statusCode, 400, `${handler.name} ${field}: ${String(value)}`);
        assert.equal(res.body.success, false);
        for (const query of queries) assert.equal(query.mock.callCount(), 0);
      }
    }
  }
});

test("product creation requires name and price even when the body is missing", async () => {
  for (const body of [undefined, null, {}, { name: "Book" }, { price: 10 }]) {
    assert.equal((await invoke(createProduct, body)).statusCode, 400);
  }
  for (const query of queries) assert.equal(query.mock.callCount(), 0);
});

test("creation trims names, accepts zero and numeric strings, and preserves defaults", async () => {
  for (const price of [0, "0", 12.5, "12.50"]) {
    const res = await invoke(createProduct, { name: "  Book  ", price });
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.product.name, "Book");
    assert.equal(res.body.product.price, Number(price));
    assert.equal(res.body.product.stock, 0);
    assert.equal(res.body.product.status, "active");
  }
});

test("partial updates validate supplied fields and leave omitted fields out of the mutation", async () => {
  for (const [body, expected] of [
    [{ description: "New description" }, { description: "New description" }],
    [{ name: "  New name  " }, { name: "New name" }],
    [{ price: "0" }, { price: 0 }],
    [{ stock: "0" }, { stock: 0 }],
    [{ stock: "3" }, { stock: 3 }],
  ]) {
    const res = await invoke(updateProduct, body);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(update.mock.calls.at(-1).arguments, [{ where: { id: 7 }, data: expected }]);
  }
});
