import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { after, beforeEach, mock, test } from "node:test";
import express from "express";

// All provider calls and authentication are synthetic; requests exercise the real
// Express parsers, upload router, Multer, content detection, and rate limiter.
process.env.CLOUDINARY_CLOUD_NAME = "cartiva-test";
process.env.CLOUDINARY_API_KEY = "local-test-key";
process.env.CLOUDINARY_API_SECRET = "local-test-secret";
process.env.PORT = "0";
const { default: cloudinary } = await import("../dist/config/cloudinary.js");
const owned = "https://res.cloudinary.com/cartiva-test/image/upload/product.png";
const external = "https://images.unsplash.com/photo-test";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
const nativeFetch = globalThis.fetch;
const remoteUpload = mock.method(cloudinary.uploader, "upload");
const streamUpload = mock.method(cloudinary.uploader, "upload_stream");
const generation = mock.method(globalThis, "fetch");
mock.module("../dist/middleware/auth.js", {
  namedExports: {
    requireAuth(req, res, next) {
      const id = req.get("x-test-user");
      if (!id) return res.status(401).json({ success: false });
      req.user = { id };
      next();
    },
  },
});
const { ImageInputError } = await import("../dist/utils/imageValidation.js");
const categoryRouter = express.Router();
categoryRouter.get("/:error", (req, res, next) => {
  next(req.params.error === "image-input"
    ? new ImageInputError("Invalid category image")
    : new Error("Unexpected category failure"));
});
mock.module("../dist/routes/categoryRoutes.js", { defaultExport: categoryRouter });

let server;
const originalListen = express.application.listen;
const listen = mock.method(express.application, "listen", function () {
  server = originalListen.call(this, 0, "127.0.0.1");
  return server;
});
await import("../dist/server.js");
listen.mock.restore();
if (!server.listening) await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}/api/upload`;
const { applyCloudinaryTransform, generateOnModelImage, uploadToCloudinary } =
  await import("../dist/controllers/uploadController.js");

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  mock.restoreAll();
});
beforeEach(() => {
  for (const fn of [remoteUpload, streamUpload, generation]) fn.mock.resetCalls();
  remoteUpload.mock.mockImplementation(async () => ({ secure_url: owned }));
  streamUpload.mock.mockImplementation((_options, callback) => ({
    end(buffer) {
      assert.deepEqual(buffer, png);
      callback(null, { secure_url: owned });
    },
  }));
  generation.mock.mockImplementation(async () => Response.json({ secure_url: owned }));
});

async function post(path, body, user = randomUUID()) {
  const multipart = body instanceof FormData;
  const response = await nativeFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      ...(user ? { "x-test-user": user } : {}),
      ...(!multipart ? { "Content-Type": "application/json" } : {}),
    },
    body: multipart ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text.startsWith("{") ? JSON.parse(text) : text };
}

function filesForm(files, field = "image") {
  const form = new FormData();
  for (const [buffer, type, name] of files) form.append(field, new Blob([buffer], { type }), name);
  return form;
}

function assertNoProviderCalls() {
  for (const fn of [remoteUpload, streamUpload, generation]) assert.equal(fn.mock.callCount(), 0);
}

test("Cloudinary configuration uses the SDK cloud_name key", () => {
  assert.equal(cloudinary.config().cloud_name, "cartiva-test");
  assert.equal(cloudinary.config().cloude_name, undefined);
});

test("recolor preserves the red default, hex and named colors, and multiple option", () => {
  assert.equal(applyCloudinaryTransform(owned, "recolor"), owned.replace("/upload/", "/upload/e_gen_recolor:prompt_object;to_color_red,f_auto,q_auto/"));
  for (const [color, expected] of [["#A1B2C3", "a1b2c3"], ["abc", "abc"], ["navy", "navy"], ["RebeccaPurple", "rebeccapurple"]]) {
    const url = applyCloudinaryTransform(owned, "recolor", { toColor: color, multiple: true });
    assert.ok(url.includes(`;to_color_${expected};multiple_true,f_auto,q_auto/`));
    assert.ok(!url.includes(" "));
  }
  assert.ok(applyCloudinaryTransform(owned, "bg-removal").includes("/e_background_removal,f_auto,q_auto/"));
});

test("color injection and invalid actions return 400 before uploads", async () => {
  for (const toColor of ["red/e_blur", "red,f_png", "red;multiple_true", "red%2Ffoo", "notacolor", "#12345", {}, [], 123]) {
    assert.equal((await post("/ai-transform", { imageUrl: external, action: "recolor", toColor })).status, 400);
  }
  for (const action of ["resize", "", null, {}, undefined]) {
    assert.equal((await post("/ai-transform", { imageUrl: external, action })).status, 400);
  }
  assertNoProviderCalls();
});

test("AI recolor prompt accepts only the restricted 1-100 character format", async () => {
  const valid = await post("/ai-transform", {
    imageUrl: owned,
    action: "recolor",
    prompt: "red wool_coat-2",
  });
  assert.equal(valid.status, 200);
  assert.ok(valid.body.url.includes("prompt_red%20wool_coat-2;"));

  for (const prompt of ["", "x".repeat(101), "two words!", "red/blue", 123, null, [], {}]) {
    const res = await post("/ai-transform", {
      imageUrl: owned,
      action: "recolor",
      prompt,
    });
    assert.equal(res.status, 400, String(prompt));
  }
  assertNoProviderCalls();
});

const invalidUrls = [
  "not a URL", "http://images.unsplash.com/photo", "ftp://images.unsplash.com/photo",
  "data:image/png;base64,aGVsbG8=", "file:///etc/passwd", "https://127.0.0.1/image",
  "https://[::1]/image", "https://169.254.169.254/image", "https://example.com/image",
  "https://res.cloudinary.com.evil.test/cartiva-test/image/upload/a.png",
  "https://evil.test/res.cloudinary.com/cartiva-test/image/upload/a.png",
  "https://evil.test/?image=https://res.cloudinary.com/cartiva-test/a.png",
  "https://res.cloudinary.com/cartiva-test-other/image/upload/a.png",
  "https://res.cloudinary.com/other-cloud/image/upload/a.png",
  "https://res.cloudinary.com/cartiva-test/image/fetch/https://images.unsplash.com/photo.png",
  "https://res.cloudinary.com/cartiva-test/video/upload/sample.mp4",
  "https://res.cloudinary.com/cartiva-test/../other-cloud/image/upload/a.png",
  "https://res.cloudinary.com@evil.test/cartiva-test/image/upload/a.png",
  "https://user:pass@res.cloudinary.com/cartiva-test/image/upload/a.png",
  "https://images.unsplash.com.evil.test/image", "https://images.unsplash.com:444/image",
  "https://res.cloudinary.com/cartiva-test", "", null, 42, {}, [owned],
];

test("AI transform rejects malformed URLs, unapproved hosts and Cloudinary impersonation", async () => {
  for (const imageUrl of invalidUrls) {
    const res = await post("/ai-transform", { imageUrl, action: "recolor" });
    assert.equal(res.status, 400, JSON.stringify(imageUrl));
  }
  assertNoProviderCalls();
});

test("both on-model URLs are validated before either upload starts", async () => {
  for (const invalid of invalidUrls) {
    for (const body of [
      { productImageUrl: invalid, modelImageUrl: external },
      { productImageUrl: external, modelImageUrl: invalid },
    ]) {
      assert.equal((await post("/ai-on-model", body)).status, 400, JSON.stringify(body));
    }
  }
  assertNoProviderCalls();
});

test("owned Cloudinary assets skip upload and external allowlisted images are imported", async () => {
  const local = await post("/ai-transform", { imageUrl: owned, action: "recolor", multiple: true });
  assert.equal(local.status, 200);
  assert.ok(local.body.url.includes(";to_color_red;multiple_true,f_auto,q_auto/"));
  assert.equal(remoteUpload.mock.callCount(), 0);
  const imported = await post("/ai-transform", { imageUrl: external, action: "bg-removal" });
  assert.equal(imported.status, 200);
  assert.deepEqual(remoteUpload.mock.calls[0].arguments, [external, { folder: "Cartiva/products", resource_type: "image" }]);
});

test("single and multiple upload failures return 500 without data URL success", async () => {
  streamUpload.mock.mockImplementation((_options, callback) => ({ end() { callback(new Error("synthetic provider failure")); } }));
  for (const [path, field] of [["/single", "image"], ["/multiple", "images"]]) {
    const res = await post(path, filesForm([[png, "image/png", "photo.png"]], field));
    assert.equal(res.status, 500);
    assert.equal(res.body.success, false);
    assert.equal(res.body.url, undefined);
    assert.equal(res.body.urls, undefined);
  }
});

test("a failure among multiple uploads returns 500", async () => {
  let count = 0;
  streamUpload.mock.mockImplementation((_options, callback) => ({ end() {
    if (++count === 2) callback(new Error("synthetic second upload failure"));
    else callback(null, { secure_url: owned });
  } }));
  const res = await post("/multiple", filesForm([[png, "image/png", "one.png"], [png, "image/png", "two.png"]], "images"));
  assert.equal(res.status, 500);
  assert.equal(res.body.success, false);
});

test("valid file bytes determine upload handling regardless of client metadata", async () => {
  const res = await post("/single", filesForm([[png, "text/plain", "photo.txt"]]));
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.url.includes("/f_auto,q_auto/"));
  assert.deepEqual(streamUpload.mock.calls[0].arguments[0], { folder: "Cartiva", resource_type: "image" });
});

test("Multer errors return JSON with the appropriate client status", async () => {
  const wrongField = await post(
    "/single",
    filesForm([[png, "image/png", "photo.png"]], "unexpected"),
  );
  assert.equal(wrongField.status, 400);
  assert.equal(wrongField.body.success, false);
  assert.equal(typeof wrongField.body.message, "string");

  const oversized = await post(
    "/single",
    filesForm([[Buffer.alloc(10 * 1024 * 1024 + 1), "image/png", "large.png"]]),
  );
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.success, false);
  assert.equal(typeof oversized.body.message, "string");
});

test("non-image MIME types return 400 JSON for single and multiple uploads", async () => {
  for (const [path, field] of [["/single", "image"], ["/multiple", "images"]]) {
    const res = await post(path, filesForm([[Buffer.from("not an image"), "text/plain", "file.txt"]], field));
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, {
      success: false,
      message: "Invalid file type. Only image files are allowed.",
    });
  }
  assertNoProviderCalls();
});

test("route error handling converts category ImageInputError and delegates other errors", async () => {
  const categoryUrl = baseUrl.replace("/api/upload", "/api/categories");
  const invalidImage = await nativeFetch(`${categoryUrl}/image-input`);
  assert.equal(invalidImage.status, 400);
  assert.deepEqual(await invalidImage.json(), { success: false, message: "Invalid category image" });

  const unexpected = await nativeFetch(`${categoryUrl}/unexpected`);
  assert.equal(unexpected.status, 500);
  assert.match(unexpected.headers.get("content-type"), /text\/html/);
  await unexpected.text();
  assertNoProviderCalls();
});

test("unsupported content, SVG, empty and truncated buffers never reach Cloudinary", async () => {
  for (const buffer of [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), Buffer.from("%PDF-1.7 fake"), Buffer.from("not an image"), Buffer.alloc(0), png.subarray(0, 10)]) {
    const res = await post("/single", filesForm([[buffer, "image/png", "fake.png"]]));
    assert.equal(res.status, 400);
  }
  await assert.rejects(uploadToCloudinary(Buffer.from("not an image")), /Only JPEG/);
  assertNoProviderCalls();
});

test("multiple-file content validation finishes before any upload starts", async () => {
  const res = await post("/multiple", filesForm([[png, "image/png", "valid.png"], [Buffer.from("bad"), "image/png", "invalid.png"]], "images"));
  assert.equal(res.status, 400);
  assertNoProviderCalls();
});

test("generation ignores requested public IDs and sends JSON with a 60-second timeout", async () => {
  const timeout = mock.method(AbortSignal, "timeout");
  const timeoutSignal = new AbortController().signal;
  timeout.mock.mockImplementation(() => timeoutSignal);
  try {
    const params = { prompt: "test", productImageUrl: owned, modelImageUrl: owned, preference: "quality", targetPublicId: "existing/asset" };
    const results = [await generateOnModelImage(params), await generateOnModelImage(params)];
    const ids = [];
    for (const { arguments: [url, options] } of generation.mock.calls) {
      assert.equal(url, "https://api.cloudinary.com/v2/generate/cartiva-test/image_to_image");
      assert.equal(options.method, "POST");
      assert.equal(options.headers["Content-Type"], "application/json");
      assert.equal(options.headers.Authorization, `Basic ${Buffer.from("local-test-key:local-test-secret").toString("base64")}`);
      assert.equal(options.signal, timeoutSignal);
      const payload = JSON.parse(options.body);
      assert.deepEqual(payload.reference_images, [{ source_type: "url", url: owned }, { source_type: "url", url: owned }]);
      assert.deepEqual(payload.model, { mode: "auto", performance: "quality" });
      assert.match(payload.target.public_id, /^tryOn\/model_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
      ids.push(payload.target.public_id);
    }
    assert.notEqual(ids[0], ids[1]);
    assert.deepEqual(results.map((result) => result.publicId), ids);
    assert.deepEqual(timeout.mock.calls.map((call) => call.arguments), [[60_000], [60_000]]);
  } finally {
    timeout.mock.restore();
  }
});

test("on-model prompts trim custom text and have correct spelling and no newline", async () => {
  const res = await post("/ai-on-model", { productImageUrl: owned, modelImageUrl: owned, customPrompt: "  studio lighting  ", targetPublicId: "overwrite/me" });
  assert.equal(res.status, 200);
  assert.equal(res.body.prompt, "Dress person in [1] in garment from [2], studio lighting, photorealistic.");
  assert.equal(remoteUpload.mock.callCount(), 0);
  const custom = await post("/ai-on-model", { productImageUrl: owned, modelImageUrl: owned, customPrompt: "  Use [1] with [2].  " });
  assert.equal(custom.body.prompt, "Use [1] with [2].");
});

test("on-model custom prompt rejects non-strings and values over the length limit", async () => {
  for (const customPrompt of [null, 123, [], {}, "x".repeat(501)]) {
    const res = await post("/ai-on-model", {
      productImageUrl: owned,
      modelImageUrl: owned,
      customPrompt,
    });
    assert.equal(res.status, 400, String(customPrompt));
  }
  assert.equal(generation.mock.callCount(), 0);
  assert.equal(remoteUpload.mock.callCount(), 0);
});

test("default model image uses the allowlisted host", async () => {
  const res = await post("/ai-on-model", { productImageUrl: owned });
  assert.equal(res.status, 200);
  assert.equal(remoteUpload.mock.callCount(), 1);
  assert.equal(new URL(remoteUpload.mock.calls[0].arguments[0]).hostname, "images.unsplash.com");
});

test("provider import failures and generation timeouts return 500", async () => {
  remoteUpload.mock.mockImplementation(async () => { throw new Error("synthetic import failure"); });
  assert.equal((await post("/ai-transform", { imageUrl: external, action: "recolor" })).status, 500);
  assert.equal((await post("/ai-on-model", { productImageUrl: owned, modelImageUrl: external })).status, 500);
  assert.equal(generation.mock.callCount(), 0);
  generation.mock.mockImplementation(async () => { throw new DOMException("Synthetic timeout", "TimeoutError"); });
  assert.equal((await post("/ai-on-model", { productImageUrl: owned, modelImageUrl: owned })).status, 500);
});

test("AI endpoints share a per-user limit and authenticate before charging requests", async () => {
  for (const path of ["/ai-transform", "/ai-on-model"]) assert.equal((await post(path, {}, null)).status, 401);
  const user = randomUUID();
  for (let i = 0; i < 10; i++) {
    const res = i % 2 === 0
      ? await post("/ai-transform", { imageUrl: owned, action: "recolor" }, user)
      : await post("/ai-on-model", { productImageUrl: owned, modelImageUrl: owned }, user);
    assert.equal(res.status, 200);
  }
  for (const path of ["/ai-transform", "/ai-on-model"]) assert.equal((await post(path, {}, user)).status, 429);
  assert.equal((await post("/ai-transform", { imageUrl: owned, action: "recolor" })).status, 200);
});

test("JSON and form bodies are limited to 100KB while multipart uploads remain separate", async () => {
  const oversized = "x".repeat(101 * 1024);
  assert.equal((await post("/ai-transform", { prompt: oversized })).status, 413);
  const response = await nativeFetch(`${baseUrl}/ai-transform`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ prompt: oversized }),
  });
  assert.equal(response.status, 413);
  await response.text();
  const multipart = filesForm([[Buffer.concat([png, Buffer.alloc(101 * 1024)]), "image/png", "photo.png"]]);
  streamUpload.mock.mockImplementation((_options, callback) => ({ end() { callback(null, { secure_url: owned }); } }));
  assert.equal((await post("/single", multipart)).status, 200);
});
