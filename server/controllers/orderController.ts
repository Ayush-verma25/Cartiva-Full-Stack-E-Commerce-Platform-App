import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";

const generateOrderNumber = () =>
  `ORD-${Date.now().toString(36).toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;

const findStore = (where: { slug?: string; id?: number }) =>
  prisma.stores.findUnique({ where: where as any });

export const createOrder = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const {
      storeSlug,
      storeId,
      items,
      customerName,
      customerEmail,
      customerPhone,
      shippingAddress,
    } = req.body;

    if (!items?.length) {
      res.status(400).json({ success: false, message: "No items in order" });
      return;
    }

    if (!customerName || !customerEmail || !shippingAddress) {
      res.status(400).json({
        success: false,
        message: "Customer name, email, and shipping address are required",
      });
      return;
    }

    const targetStore = storeSlug
      ? await findStore({ slug: storeSlug })
      : storeId
        ? await findStore({ id: Number(storeId) })
        : null;

    if (!targetStore) {
      res.status(404).json({ success: false, message: "Store not found" });
      return;
    }

    if (targetStore.status === "suspended") {
      res
        .status(403)
        .json({ success: false, message: "This store is suspended" });
      return;
    }

    let subtotal = 0;
    const processedItems = [];

    for (const item of items) {
      const product = await prisma.products.findFirst({
        where: { id: Number(item.productId), store_id: targetStore.id },
      });
      if (!product) {
        res.status(404).json({
          success: false,
          message: `Product ${item.name || item.productId} no longer exists`,
        });
        return;
      }

      const qty = Math.max(1, Number(item.quantity) || 1);
      if ((product.stock ?? 0) < qty) {
        res.status(400).json({
          success: false,
          message: `Not enough stock for ${item.name}. Available: ${product.stock}`,
        });
        return;
      }

      const itemPrice = Number(product.price);
      subtotal += itemPrice * qty;
      const images = Array.isArray(product.images)
        ? (product.images as string[])
        : [];

      processedItems.push({
        productId: product.id,
        name: product.name,
        price: itemPrice,
        quantity: qty,
        variant: item.variant || null,
        image: images[0] || null,
      });

      await prisma.products.update({
        where: { id: product.id },
        data: { stock: { decrement: qty } },
      });
    }

    const shippingFee = Number(targetStore.shipping_fee) || 0;
    const freeThreshold = Number(targetStore.free_shipping_threshold) || 0;
    const shippingCost =
      freeThreshold > 0 && subtotal >= freeThreshold ? 0 : shippingFee;
    const total = Math.max(0, subtotal + shippingCost);
    const customerId = req.user?.id || null;

    const order = await prisma.orders.create({
      data: {
        order_number: generateOrderNumber(),
        store_id: targetStore.id,
        customer_id: customerId,
        customer_name: customerName.trim(),
        customer_email: customerEmail.trim().toLowerCase(),
        customer_phone: customerPhone || null,
        shipping_address: shippingAddress,
        items: processedItems,
        subtotal,
        discount: 0,
        shipping_cost: shippingCost,
        total,
        coupon_code: null,
        payment_status: "pending",
        payment_method: "cod",
        order_status: "placed",
      },
    });

    res
      .status(201)
      .json({ success: true, message: "Order created successfully", order });
  } catch (error: any) {
    console.error("createOrder error:", error);
    res.status(500).json({ success: false, message: "Failed to create order" });
  }
};

export const getMerchantOrders = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const store = await prisma.stores.findFirst({
      where: { merchant_id: req.user?.id },
    });

    if (!store) {
      res.status(404).json({ success: false, message: "Store not found" });
      return;
    }

    const { status } = req.query;

    const orders = await prisma.orders.findMany({
      where: {
        store_id: store.id,
        ...(status ? { order_status: status as string } : {}),
      },
      orderBy: { created_at: "desc" },
    });

    res.status(200).json({ success: true, orders });
  } catch (error: any) {
    console.error("getMerchantOrders error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch merchant orders" });
  }
};

export const updateOrderStatus = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const store = await prisma.stores.findFirst({
      where: { merchant_id: req.user?.id },
    });

    if (!store) {
      res.status(404).json({ success: false, message: "Store not found" });
      return;
    }

    const { id } = req.params;

    const { order_status, tracking_number, payment_status } = req.body;

    const existing = await prisma.orders.findFirst({
      where: { id: Number(id), store_id: store.id },
    });

    if (!existing) {
      res.status(404).json({ success: false, message: "Order not found" });
      return;
    }

    const updated = await prisma.orders.update({
      where: { id: Number(id) },
      data: {
        order_status: order_status || existing.order_status,
        tracking_number:
          tracking_number !== undefined
            ? tracking_number
            : existing.tracking_number,
        payment_status: payment_status || existing.payment_status,
      },
    });

    res.json({
      success: true,
      message: "Order updated successfully",
      order: updated,
    });
  } catch (error: any) {
    console.error("updateOrderStatus error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to update order status" });
  }
};

export const getOrderReceipt = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const ident = String(req.params.orderIdentifier);
    const parsedId = !isNaN(Number(ident)) ? Number(ident) : -1;
    const raw = await prisma.orders.findFirst({
      where: { OR: [{ order_number: ident }, { id: parsedId }] },
      include: {
        stores: {
          select: {
            name: true,
            slug: true,
            currency: true,
            logo_url: true,
            banner_url: true,
            accent_color: true,
          },
        },
      },
    });

    if (!raw) {
      res.status(404).json({ success: false, message: "Order not found" });
      return;
    }

    const { stores, ...rest } = raw;
    res.json({
      success: true,
      order: {
        ...rest,
        store_name: stores?.name || null,
        store_slug: stores?.slug || null,
        store_currency: stores?.currency || "USD",
        store_logo_url: stores?.logo_url || null,
        store_accent_color: stores?.accent_color || "#059669",
      },
    });
  } catch (error: any) {
    console.error("getOrderReceipt error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to get order receipt" });
  }
};

export const getCustomerOrders = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { id: userId, email: userEmail } = req.user!;
    const { storeSlug, storeId } = req.query!;

    const targetStore = storeSlug
      ? await findStore({
          slug: String(storeSlug),
        })
      : storeId
        ? await findStore({
            id: Number(storeId),
          })
        : null;

    const whereClause: any = {
      OR: [
        { customer_id: userId },
        ...(userEmail
          ? [
              {
                customer_email: {
                  equals: userEmail,
                  mode: "insensitive" as const,
                },
              },
            ]
          : []),
      ],
    };

    if (targetStore) {
      whereClause.store_id = targetStore.id;
    }

    const rawOrders = await prisma.orders.findMany({
      where: whereClause,
      include: {
        stores: { select: { name: true, slug: true, currency: true } },
      },
      orderBy: { created_at: "desc" },
    });

    const orders = rawOrders.map(({ stores, ...rest }) => ({
      ...rest,
      store_name: stores?.name || null,
      store_slug: stores?.slug || null,
      store_currency: stores?.currency || "USD",
    }));

    res.json({ success: true, orders });
  } catch (error: any) {
    console.error("getCustomerOrders error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to get customer orders" });
  }
};
