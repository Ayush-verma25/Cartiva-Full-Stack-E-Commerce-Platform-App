import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  createProduct,
  deleteProduct,
  updateProduct,
} from "../controllers/productController.js";

const productRouter = Router();

productRouter.post("/", requireAuth, requireRole(["merchant"]), createProduct);
productRouter.put(
  "/:id",
  requireAuth,
  requireRole(["merchant"]),
  updateProduct,
);
productRouter.delete(
  "/:id",
  requireAuth,
  requireRole(["merchant"]),
  deleteProduct,
);

export default productRouter;