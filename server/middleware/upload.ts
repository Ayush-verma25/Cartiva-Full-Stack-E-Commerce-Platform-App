import multer from "multer";
import { RequestHandler } from "express";
import { ImageInputError, validateImageBuffer } from "../utils/imageValidation.js";

const storage = multer.memoryStorage();

const maxFileSize = 10485760; // 10MB

export const upload = multer({
  storage,
  limits: {
    fileSize: maxFileSize,
  },
});

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
