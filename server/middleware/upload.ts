import multer from "multer";
import type { RequestHandler } from "express";
import { ImageInputError, validateImageBuffer } from "../utils/imageValidation.js";

const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10485760 },
});

const wrapMulterHandler = (handler: RequestHandler): RequestHandler =>
  (req, res, next) => {
    handler(req, res, (error) => {
      if (error instanceof multer.MulterError) {
        res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
          success: false,
          message: error.message,
        });
        return;
      }
      next(error);
    });
  };

export const upload = {
  single: (fieldName: string): RequestHandler =>
    wrapMulterHandler(multerUpload.single(fieldName)),
  array: (fieldName: string, maxCount?: number): RequestHandler =>
    wrapMulterHandler(multerUpload.array(fieldName, maxCount)),
};

export const validateUploadedImages: RequestHandler = async (req, res, next) => {
  const files = req.file ? [req.file] : (req.files as Express.Multer.File[] || []);
  try {
    await Promise.all(files.map((file) => validateImageBuffer(file.buffer)));
    next();
  } catch (error) {
    if (error instanceof ImageInputError) {
      res.status(400).json({ success: false, message: error.message });
      return;
    }
    next(error);
  }
};
