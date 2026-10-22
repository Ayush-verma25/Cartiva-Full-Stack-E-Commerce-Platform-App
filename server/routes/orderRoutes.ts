import { Router } from "express";
import {
  createOrder,
  getCustomerOrders,
  getMerchantOrders,
  getOrderReceipt,
  updateOrderStatus,
} from "../controllers/orderController.js";
import { optionalAuth, requireRole } from "../middleware/auth.js";

const orderRouter = Router();

// Public checkout & receipts
orderRouter.post("/checkout", optionalAuth, createOrder);
orderRouter.get("/receipt/:orderIdentifier", getOrderReceipt);

// Customer order history
orderRouter.get("/customer/my-orders", optionalAuth, getCustomerOrders);

// Merchant order
orderRouter.get(
  "/merchant",
  optionalAuth,
  requireRole(["merchant"]),
  getMerchantOrders,
);
orderRouter.patch(
  "/merchant/:id/status",
  optionalAuth,
  requireRole(["merchant"]),
  updateOrderStatus,
);

export default orderRouter;