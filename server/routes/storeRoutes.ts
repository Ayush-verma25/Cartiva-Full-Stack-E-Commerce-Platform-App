import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import {
  createStore,
  getAllMerchants,
  getAllStores,
  getMyStore,
  onboardMerchant,
  toggelStoreStatus,
  updateMyStore,
} from "../controllers/storeController.js";

const storeRouter = Router();

// Merchant routes
storeRouter.post("/", requireAuth, createStore);
storeRouter.post("/onboard-merchant", requireAuth, onboardMerchant);
storeRouter.get("/me", requireAuth, getMyStore);
storeRouter.put("/me", requireAuth, updateMyStore);

// Platform Admin routes
storeRouter.get("/admin/all", requireAuth, requireRole(["admin"]), getAllStores);
storeRouter.get(
  "/admin/merchants",
  requireAuth,
  requireRole(["admin"]),
  getAllMerchants,
);
storeRouter.patch(
  "/admin/:storeId/status",
  requireAuth,
  requireRole(["admin"]),
  toggelStoreStatus,
);

export default storeRouter;
