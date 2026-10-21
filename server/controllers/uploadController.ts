import { Request, Response } from "express";
import cloudinary from "../config/cloudinary.js";

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
      : `e_gen_recolor:prompt_${encodeURIComponent(options.prompt || "object")};to_color_${(options.toColor || "red").replace("#", "")}${options.multiple ? ";multiple_true" : ""}, f_auto,q_auto`;

  return url.replace("/image/upload/", `/image/upload/${transform}/`);
}

export const uploadToCloudinary = async (
  fileBuffer: Buffer,
  folder: string = "Cartiva",
  options: { mimetype?: string; filename?: string } = {},
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const isSvg =
      options.mimetype === "image/svg+xml" ||
      options.filename?.endsWith(".svg");
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder, resource_type: "image", ...(isSvg ? { format: "svg" } : {}) },
      (error, result) => {
        if (error || !result) reject(error || new Error("Upload failed"));
        else
          resolve(
            isSvg ? result.secure_url : optimizeDeliveryUrl(result.secure_url),
          );
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

    const url = await uploadToCloudinary(req.file.buffer, "Cartiva", {
      mimetype: req.file.mimetype,
      filename: req.file.originalname,
    })

    res.json({ success: true, message: "Image uploaded successfully", url });
  } catch (error: any) {
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

    const urls = await Promise.all(
      files.map((file) =>
        uploadToCloudinary(file.buffer, "Cartiva", {
          mimetype: file.mimetype,
          filename: file.originalname,
        })
      ),
    );

    res.json({ success: true, message: "Images uploaded successfully", urls });
  } catch (error: any) {
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
    const { imageUrl, action, prompt, toColor, multiple } = req.body;

    if (!imageUrl) {
      res
        .status(400)
        .json({ success: false, message: "valid imageUrl is required" });
      return;
    }

    let baseCloudinaryUrl = imageUrl;
    const cloudName = cloudinary.config().cloude_name;

    // Ensure image is hosted on cloudinary
    if (!cloudName || !imageUrl.includes(`res.cloudinary.com/${cloudName}/`)) {
      const uploadResult = await cloudinary.uploader.upload(imageUrl, {
        folder: "Cartiva/products",
        resource_type: "image",
      });
      baseCloudinaryUrl = uploadResult.secure_url;
    }

    const transformedUrl = applyCloudinaryTransform(baseCloudinaryUrl, action, {
      prompt,
      toColor,
      multiple: Boolean(multiple),
    });

    res.json({
      success: true,
      url: transformedUrl,
      originalUrl: imageUrl,
      action,
    });
  } catch (error: any) {
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
  const cloudName = cloudinary.config().cloude_name;
  if (cloudName && url.includes(`res.cloudinary.com/${cloudName}/`)) {
    return url;
  }
  const res = await cloudinary.uploader
    .upload(url, { folder, resource_type: "image" })
    .catch(() => null);
  return res?.secure_url || url;
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

  const targetPublicId =
    params.targetPublicId?.trim() || `tryOn/model_${Date.now()}`;
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
        Content_Type: "application/json",
      },
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
      targetPublicId,
    } = req.body;

    if (!productImageUrl) {
      res
        .status(400)
        .json({ success: false, message: "productImageUrl is required" });
      return;
    }

    const defaultModel =
      "https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?q=80&w=687&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=NHwxMjA3fDA%3D";

    const [modelUrl, productUrl] = await Promise.all([
      ensureCloudinaryUrl(modelImageUrl || defaultModel, "Cartiva/models"),
      ensureCloudinaryUrl(productImageUrl, "Cartiva/products"),
    ]);

    const prompt = customPrompt?.trim()
      ? customPrompt.includes("[1]") && customPrompt.includes("[2]")
        ? customPrompt.trim()
        : `Dress person in [1] in garment ftom [2], ${customPrompt.trim()},
        photorealistic.`
      : `Dress person in [1] in ${garmentType || "garment"} from [2], pose ${pose || "confident standing position"}, background ${background || "clean white"}, photorealistic.`;

    const result = await generateOnModelImage({
      prompt,
      modelImageUrl: modelUrl,
      productImageUrl: productUrl,
      targetPublicId,
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
    console.log(error?.message);
    res
      .status(500)
      .json({
        success: false,
        message: "Failed to generate on-model catalog photo",
      });
  }
};
