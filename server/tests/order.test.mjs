import assert from "node:assert/strict";
import { after, beforeEach, mock, test } from "node:test";

const userId = "c385b95f-26af-46fd-8570-46304d7380a8";
const findStore = mock.fn();
const findMerchantStore = mock.fn();
const findOrder = mock.fn();
const findOrders = mock.fn();
const updateOrder = mock.fn();
const findProduct = mock.fn();
const decrementStock = mock.fn();
const insertOrder = mock.fn();
const transaction = mock.fn();
const logError = mock.method(console, "error", () => {});
const queries = [findStore, findMerchantStore, findOrder, findOrders, updateOrder,
  findProduct, decrementStock, insertOrder, transaction];
const transactionClient = {
  products: { findFirst: findProduct, updateMany: decrementStock },
  orders: { create: insertOrder },
};
// Checkout mutations exist only on this transaction client; global use fails.
mock.module("../dist/config/prisma.js", {
  namedExports: {
    prisma: {
      stores: { findUnique: findStore, findFirst: findMerchantStore },
      orders: { findFirst: findOrder, findMany: findOrders, update: updateOrder },
      $transaction: transaction,
    },
  },
});
const { createOrder, updateOrderStatus, getOrderReceipt, getCustomerOrders } =
  await import("../dist/controllers/orderController.js");
after(() => mock.restoreAll());
beforeEach(() => {
  for (const fn of [...queries, logError]) fn.mock.resetCalls();
  findStore.mock.mockImplementation(async () => ({ id: 11, status: "active", shipping_fee: 5, free_shipping_threshold: 30 }));
  findMerchantStore.mock.mockImplementation(async () => ({ id: 11 }));
  findProduct.mock.mockImplementation(async ({ where }) => ({
    id: where.id, store_id: 11, name: "Book", price: "10.00",
    stock: 10, images: ["book.png"], status: "active",
  }));
  decrementStock.mock.mockImplementation(async () => ({ count: 1 }));
  insertOrder.mock.mockImplementation(async ({ data }) => ({ id: 7, ...data }));
  transaction.mock.mockImplementation(async (callback) => callback(transactionClient));
  findOrder.mock.mockImplementation(async () => ({ id: 7, store_id: 11,
    order_status: "placed", payment_status: "pending", tracking_number: "existing" }));
  updateOrder.mock.mockImplementation(async ({ data }) => ({ id: 7, ...data }));
  findOrders.mock.mockImplementation(async () => []);
});

function checkoutBody(items = [{ productId: 3, quantity: 2 }]) {
  return { storeSlug: "book-shop", items, customerName: "  Reader  ",
    customerEmail: "Reader@Example.test", shippingAddress: { city: "Test City" } };
}
async function invoke(handler, request = {}) {
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler({ user: { id: userId, email: "Reader@Example.test" },
    params: { id: "7" }, query: {}, body: {}, ...request }, res);
  return res;
}

// Failures must escape the callback, since returning a response inside it commits.
async function assertTransactionRejected(pattern) {
  assert.equal(transaction.mock.callCount(), 1);
  await assert.rejects(transaction.mock.calls[0].result, pattern);
}

test("checkout rejects nonarrays and invalid quantities before database access", async () => {
  for (const items of [null, [], "items", { length: 1 },
    ...[undefined, null, 0, -1, 1.5, "2", true, NaN, Infinity].map((quantity) => [{ productId: 3, quantity }]),
    [null], [{ productId: 3, quantity: 1 }, { productId: 4, quantity: 0 }]]) {
    const res = await invoke(createOrder, { body: checkoutBody(items) });
    assert.equal(res.statusCode, 400, `items: ${JSON.stringify(items)}`);
  }
  for (const query of queries) assert.equal(query.mock.callCount(), 0);
});

test("missing checkout items and bodies return 400 without database access", async () => {
  for (const body of [undefined, null, {}, { ...checkoutBody(), items: undefined }]) {
    assert.equal((await invoke(createOrder, { body })).statusCode, 400);
  }
  for (const query of queries) assert.equal(query.mock.callCount(), 0);
});

test("checkout prices items from the database and conditionally decrements within the order transaction", async () => {
  const res = await invoke(createOrder, { body: checkoutBody() });
  assert.equal(res.statusCode, 201);
  assert.equal(transaction.mock.callCount(), 1);
  assert.deepEqual(findProduct.mock.calls[0].arguments, [{ where: { id: 3, store_id: 11, status: "active" } }]);
  assert.deepEqual(decrementStock.mock.calls[0].arguments, [{
    where: { id: 3, store_id: 11, status: "active", stock: { gte: 2 } },
    data: { stock: { decrement: 2 } },
  }]);
  assert.equal(res.body.order.subtotal, 20);
  assert.equal(res.body.order.shipping_cost, 5);
  assert.equal(res.body.order.total, 25);
  assert.equal(res.body.order.customer_name, "Reader");
  assert.equal(res.body.order.customer_email, "reader@example.test");
  assert.deepEqual(res.body.order.items, [{ productId: 3, name: "Book", price: 10,
    quantity: 2, variant: null, image: "book.png" }]);
  const guest = await invoke(createOrder, { user: undefined, body: checkoutBody([{ productId: 3, quantity: 3 }]) });
  assert.equal(guest.statusCode, 201);
  assert.equal(guest.body.order.shipping_cost, 0);
  assert.equal(guest.body.order.customer_id, null);
  for (const order of [res.body.order, guest.body.order]) {
    assert.match(order.order_number, /^ORD-[A-Z0-9]+-[A-F0-9]{32}$/);
  }
  assert.notEqual(res.body.order.order_number, guest.body.order.order_number);
});

test("a missing or inactive later product rejects the transaction after earlier decrements", async () => {
  findProduct.mock.mockImplementation(async ({ where }) =>
    where.id === 3 ? { id: 3, name: "Book", price: 10 } : null);
  const res = await invoke(createOrder, { body: checkoutBody([
    { productId: 3, quantity: 1 }, { productId: 4, quantity: 1 },
  ]) });
  assert.equal(res.statusCode, 404);
  assert.equal(decrementStock.mock.callCount(), 1);
  assert.equal(insertOrder.mock.callCount(), 0);
  await assertTransactionRejected(/no longer available/);
  assert.equal(findProduct.mock.calls[1].arguments[0].where.status, "active");
});

test("a failed conditional stock update rejects the whole transaction even after an available stock read", async () => {
  let updates = 0;
  decrementStock.mock.mockImplementation(async () => ({ count: ++updates === 1 ? 1 : 0 }));
  const res = await invoke(createOrder, { body: checkoutBody([
    { productId: 3, quantity: 1 }, { productId: 4, quantity: 1 },
  ]) });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /Not enough stock/);
  assert.equal(insertOrder.mock.callCount(), 0);
  await assertTransactionRejected(/Not enough stock/);
});

test("repeated product lines cannot bypass the remaining stock condition", async () => {
  let stock = 3;
  decrementStock.mock.mockImplementation(async ({ where, data }) => {
    if (stock < where.stock.gte) return { count: 0 };
    stock -= data.stock.decrement;
    return { count: 1 };
  });
  const res = await invoke(createOrder, { body: checkoutBody([
    { productId: 3, quantity: 2 }, { productId: 3, quantity: 2 },
  ]) });
  assert.equal(res.statusCode, 400);
  assert.equal(insertOrder.mock.callCount(), 0);
  await assertTransactionRejected(/Not enough stock/);
});

test("order insertion errors reject the transaction after stock decrements", async () => {
  const failure = new Error("synthetic order insertion failure");
  insertOrder.mock.mockImplementation(async () => { throw failure; });
  const res = await invoke(createOrder, { body: checkoutBody() });
  assert.equal(res.statusCode, 500);
  assert.equal(decrementStock.mock.callCount(), 1);
  await assertTransactionRejected((error) => error === failure);
});

test("invalid update IDs and fields return 400 before Prisma queries", async () => {
  for (const id of [undefined, "bad", "1.5", "NaN", "Infinity"]) {
    assert.equal((await invoke(updateOrderStatus, { params: { id } })).statusCode, 400);
  }
  for (const body of [
    ...["unknown", "", null, 1, {}, ["placed"]].map((order_status) => ({ order_status })),
    ...["unknown", "", null, 1, {}, ["paid"]].map((payment_status) => ({ payment_status })),
    ...[null, 123, true, [], {}, "x".repeat(101)].map((tracking_number) => ({ tracking_number })),
  ]) {
    assert.equal((await invoke(updateOrderStatus, { body })).statusCode, 400);
  }
  for (const query of queries) assert.equal(query.mock.callCount(), 0);
});

test("valid status updates remain scoped to the merchant and preserve omitted fields", async () => {
  for (const body of [
    ...["placed", "confirmed", "processing", "shipped", "delivered", "cancelled"].map((order_status) => ({ order_status })),
    ...["pending", "paid", "failed", "refunded"].map((payment_status) => ({ payment_status })),
    { tracking_number: "x".repeat(100) }, { tracking_number: "" }, {},
  ]) {
    const res = await invoke(updateOrderStatus, { body });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(findOrder.mock.calls.at(-1).arguments, [{ where: { id: 7, store_id: 11 } }]);
    assert.deepEqual(updateOrder.mock.calls.at(-1).arguments, [{ where: { id: 7 }, data: {
      order_status: body.order_status ?? "placed", payment_status: body.payment_status ?? "pending",
      tracking_number: body.tracking_number ?? "existing",
    } }]);
  }
});

test("receipts use only order numbers, including numeric identifiers", async () => {
  for (const orderIdentifier of ["7", "ORD-EXAMPLE"]) {
    findOrder.mock.mockImplementation(async ({ where }) =>
      where.order_number === "ORD-EXAMPLE" ? { id: 7, stores: { name: "Book Shop" } } : null);
    const res = await invoke(getOrderReceipt, { params: { orderIdentifier } });
    assert.equal(res.statusCode, orderIdentifier === "7" ? 404 : 200);
    assert.deepEqual(findOrder.mock.calls.at(-1).arguments[0].where, { order_number: orderIdentifier });
  }
});

test("customer history requires a user before any queries", async () => {
  const res = await invoke(getCustomerOrders, { user: undefined });
  assert.equal(res.statusCode, 401);
  for (const query of queries) assert.equal(query.mock.callCount(), 0);
});

test("customer history matches the user's ID and case-insensitive email with optional store scoping", async () => {
  findOrders.mock.mockImplementation(async () => [{ id: 7, stores: { name: "Book Shop", slug: "book-shop", currency: "USD" } }]);
  const res = await invoke(getCustomerOrders, { query: { storeSlug: "book-shop" } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(findOrders.mock.calls[0].arguments[0].where, { store_id: 11, OR: [
    { customer_id: userId }, { customer_email: { equals: "Reader@Example.test", mode: "insensitive" } },
  ] });
  assert.deepEqual(res.body.orders, [{ id: 7, store_name: "Book Shop", store_slug: "book-shop", store_currency: "USD" }]);
  const noEmail = await invoke(getCustomerOrders, { user: { id: userId } });
  assert.equal(noEmail.statusCode, 200);
  assert.deepEqual(findOrders.mock.calls.at(-1).arguments[0].where, { OR: [{ customer_id: userId }] });
});
