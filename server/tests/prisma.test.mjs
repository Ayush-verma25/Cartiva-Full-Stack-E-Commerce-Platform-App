import "dotenv/config";
import assert from "node:assert/strict";
import { after, mock, test } from "node:test";

const databaseUrl = process.env.DATABASE_URL;
const adapter = mock.fn();
const client = mock.fn();
mock.module("@prisma/adapter-pg", { namedExports: { PrismaPg: adapter } });
mock.module("../dist/generated/prisma/client.js", { namedExports: { PrismaClient: client } });
after(() => {
  mock.restoreAll();
  if (databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = databaseUrl;
});

test("missing DATABASE_URL fails before constructing the adapter or client", async () => {
  delete process.env.DATABASE_URL;
  await assert.rejects(import("../dist/config/prisma.js?missing"), /DATABASE_URL must be set/);
  process.env.DATABASE_URL = "";
  await assert.rejects(import("../dist/config/prisma.js?empty"), /DATABASE_URL must be set/);
  assert.equal(adapter.mock.callCount(), 0);
  assert.equal(client.mock.callCount(), 0);
});

test("configured DATABASE_URL reaches the adapter unchanged", async () => {
  process.env.DATABASE_URL = "postgresql://local:local@localhost/cartiva_test";
  await import("../dist/config/prisma.js?configured");
  assert.deepEqual(adapter.mock.calls[0].arguments, [{ connectionString: process.env.DATABASE_URL }]);
  assert.equal(client.mock.callCount(), 1);
});
