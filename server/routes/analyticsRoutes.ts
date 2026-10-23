import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  getMerchantAnalytics,
  getPlatformAnalytics,
} from "../controllers/analyticsController.js";

const analyticsRoutes = Router();

analyticsRoutes.get(
  "/merchant",
  requireAuth,
  requireRole(["merchant"]),
  getMerchantAnalytics,
);
analyticsRoutes.get(
  "/platform",
  requireAuth,
  requireRole(["admin"]),
  getPlatformAnalytics,
);

export default analyticsRoutes;