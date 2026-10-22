import { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import cloudinary from "../config/cloudinary.js";
import {
  ImageInputError,
  isOwnedCloudinaryUrl,
  normalizeColor,
  validateImageBuffer,
  validateImageUrl,
} from "../utils/imageValidation.js";

export const optimizeDeliveryUrl = (url: string): string => {
  if (!url || typeof url !== "string" || url.includes(".svg")) return url;
  return url.replace(
    /\/image\/upload\/(?!f_auto,q_auto\/)/,
    "/image/upload/f_auto,q_auto/",
  );
};

export function applyCloudinaryTransform(
  url: string,
  action: "recolor" | "bg-removal",
  options: { prompt?: string; toColor?: string; multiple?: boolean } = {},
): string {
  const transform =
    action === "bg-removal"
      ? "e_background_removal,f_auto,q_auto"
      : `e_gen_recolor:prompt_${encodeURIComponent(options.prompt || "object")};to_color_${normalizeColor(options.toColor)}${options.multiple ? ";multiple_true" : ""},f_auto,q_auto`;

  return url.replace("/image/upload/", `/image/upload/${transform}/`);
}

export const uploadToCloudinary = async (
  fileBuffer: Buffer,
  folder: string = "Cartiva",
): Promise<string> => {
  await validateImageBuffer(fileBuffer);
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image" },
      (error, result) => {
        if (error || !result) reject(error || new Error("Upload failed"));
        else resolve(optimizeDeliveryUrl(result.secure_url));
      },
    );
    uploadStream.end(fileBuffer);
  });
};

// Upload single image
export const uploadSingle = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ success: false, message: "No file uploaded" });
      return;
    }

    const url = await uploadToCloudinary(req.file.buffer, "Cartiva");

    res.json({ success: true, message: "Image uploaded successfully", url });
  } catch (error: any) {
    if (error instanceof ImageInputError) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    console.error(error?.message);
    res.status(500).json({ success: false, message: "image upload failed" });
  }
};

// Upload multiple images in parallel
export const uploadMultiple = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const files = (req.files as Express.Multer.File[]) || [];
    if (files.length === 0) {
      res.status(400).json({ success: false, message: "No files uploaded" });
      return;
    }

    await Promise.all(files.map((file) => validateImageBuffer(file.buffer)));
    const urls = await Promise.all(
      files.map((file) => uploadToCloudinary(file.buffer, "Cartiva")),
    );

    res.json({ success: true, message: "Images uploaded successfully", urls });
  } catch (error: any) {
    if (error instanceof ImageInputError) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    console.error(error?.message);
    res.status(500).json({ success: false, message: "image upload failed" });
  }
};

// AI Transformation (Generative Recolor & Background Removal)
export const aiTransform = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { imageUrl, action, prompt, toColor, multiple } = req.body || {};
    let validatedPrompt: string | undefined;

    if (prompt !== undefined) {
      if (typeof prompt !== "string" || !/^[A-Za-z0-9 _-]{1,100}$/.test(prompt)) {
        throw new ImageInputError(
          "prompt must be 1-100 letters, digits, spaces, underscores, or hyphens",
        );
      }
      validatedPrompt = prompt;
    }

    if (!imageUrl) {
      res
        .status(400)
        .json({ success: false, message: "valid imageUrl is required" });
      return;
    }

    if (action !== "recolor" && action !== "bg-removal") {
      throw new ImageInputError("action must be recolor or bg-removal");
    }
    const color = action === "recolor" ? normalizeColor(toColor) : undefined;
    const baseCloudinaryUrl = await ensureCloudinaryUrl(imageUrl, "Cartiva/products");

    const transformedUrl = applyCloudinaryTransform(baseCloudinaryUrl, action, {
      prompt: validatedPrompt,
      toColor: color,
      multiple: Boolean(multiple),
    });

    res.json({
      success: true,
      url: transformedUrl,
      originalUrl: imageUrl,
      action,
    });
  } catch (error: any) {
    if (error instanceof ImageInputError) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    console.error(error?.message);
    res
      .status(500)
      .json({ success: false, message: "AI Transformation failed" });
  }
};

const ensureCloudinaryUrl = async (
  url: string,
  folder = "Cartiva/tryon",
): Promise<string> => {
  const cloudName = cloudinary.config().cloud_name;
  const parsed = validateImageUrl(url, cloudName);
  if (isOwnedCloudinaryUrl(parsed, cloudName)) {
    return parsed.href;
  }
  const res = await cloudinary.uploader.upload(parsed.href, { folder, resource_type: "image" });
  return res.secure_url;
};

export interface GenerateOnModelParams {
  prompt: string;
  productImageUrl: string;
  modelImageUrl: string;
  targetPublicId?: string;
  preference?: string;
}

export interface GenerateOnModelResult {
  secureUrl: string;
  publicId: string;
  model?: string;
  limits?: any;
}

export const generateOnModelImage = async (
  params: GenerateOnModelParams,
): Promise<GenerateOnModelResult> => {
  const { cloud_name, api_key, api_secret } = cloudinary.config();
  if (!cloud_name || !api_key || !api_secret) {
    throw new Error("Cloudinary instance credentials are not configured");
  }

  const targetPublicId = `tryOn/model_${randomUUID()}`;
  const payload = {
    prompt: params.prompt,
    reference_images: [
      { source_type: "url", url: params.modelImageUrl },
      { source_type: "url", url: params.productImageUrl },
    ],
    model: {
      mode: "auto",
      ...(params.preference ? { performance: params.preference } : {}),
    },
    target: { target_type: "managed_asset", public_id: targetPublicId },
  };

  const response = await fetch(
    `https://api.cloudinary.com/v2/generate/${cloud_name}/image_to_image`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${api_key}:${api_secret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify(payload),
    },
  );
  const data: any = await response.json().catch(() => null);

  if (!response.ok || !data) {
    const err: any = new Error(
      data?.error?.message ||
        data?.message ||
        `Cloudinary API error (${response.status})`,
    );
    err.status = response.status;
    err.details = data?.error;
    throw err;
  }
  const asset = data?.data?.assets?.[0] || data?.data?.result?.assets?.[0];

  const rawUrl =
    asset?.storage?.secure_url || asset?.secure_url || data?.secure_url;
  if (!rawUrl)
    throw new Error("No image URL returned from Cloudinary generation");

  return {
    secureUrl: optimizeDeliveryUrl(rawUrl),
    publicId: asset?.storage?.public_id || targetPublicId,
    model: asset?.model,
    limits: data?.data?.limits,
  };
};

// Controller endpoint for On-Model catalog photography / virtual try-on
export const aiOnModel = async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      productImageUrl,
      modelImageUrl,
      garmentType,
      pose,
      background,
      customPrompt,
      preference,
    } = req.body || {};

    if (customPrompt !== undefined && typeof customPrompt !== "string") {
      throw new ImageInputError("customPrompt must be a string");
    }
    if (typeof customPrompt === "string" && customPrompt.length > 500) {
      throw new ImageInputError("customPrompt must be 500 characters or fewer");
    }

    if (!productImageUrl) {
      res
        .status(400)
        .json({ success: false, message: "productImageUrl is required" });
      return;
    }

    const defaultModel =
      "https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?q=80&w=687&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=NHwxMjA3fDA%3D";

    // Validate both inputs before either can trigger a remote upload.
    const cloudName = cloudinary.config().cloud_name;
    const modelSource = modelImageUrl === undefined ? defaultModel : modelImageUrl;
    validateImageUrl(productImageUrl, cloudName);
    validateImageUrl(modelSource, cloudName);

    const [modelUrl, productUrl] = await Promise.all([
      ensureCloudinaryUrl(modelSource, "Cartiva/models"),
      ensureCloudinaryUrl(productImageUrl, "Cartiva/products"),
    ]);

    const prompt = customPrompt?.trim()
      ? customPrompt.includes("[1]") && customPrompt.includes("[2]")
        ? customPrompt.trim()
        : `Dress person in [1] in garment from [2], ${customPrompt.trim()}, photorealistic.`
      : `Dress person in [1] in ${garmentType || "garment"} from [2], pose ${pose || "confident standing position"}, background ${background || "clean white"}, photorealistic.`;

    const result = await generateOnModelImage({
      prompt,
      modelImageUrl: modelUrl,
      productImageUrl: productUrl,
      preference,
    });

    res.json({
      success: true,
      url: result.secureUrl,
      publicId: result.publicId,
      model: result.model,
      prompt,
      modelUrl,
      productUrl,
      limits: result.limits,
    });
  } catch (error: any) {
    if (error instanceof ImageInputError) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    console.log(error?.message);
    res
      .status(500)
      .json({
        success: false,
        message: "Failed to generate on-model catalog photo",
      });
  }
};
