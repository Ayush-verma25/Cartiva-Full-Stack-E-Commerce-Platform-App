import { Router } from "express";
import {
  createCategories,
  deleteCategories,
  getCategories,
} from "../controllers/categoryController.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const categoryRouter = Router();

// Public / customer can view categories
categoryRouter.get("/", getCategories);

// Merchant can create categories
categoryRouter.post(
  "/",
  requireAuth,
  requireRole(["merchant"]),
  createCategories,
);
categoryRouter.delete(
  "/:id",
  requireAuth,
  requireRole(["merchant"]),
  deleteCategories,
);

export default categoryRouter;