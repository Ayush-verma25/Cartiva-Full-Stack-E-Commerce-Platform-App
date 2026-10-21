import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../config/prisma.js";

const generateSlug = (text: string) =>
  text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]+/g, "");
const parseId = (value: unknown): number | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 && id <= 2_147_483_647 ? id : null;
};

const getStore = (merchantId: string, storeId: number) =>
  prisma.stores.findFirst({ where: { id: storeId, merchant_id: merchantId } });

export const getCategories = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { storeId, storeSlug } = req.query;
    let targatStoreId = parseId(storeId);

    if (storeId !== undefined && targatStoreId === null) {
      res.status(400).json({ success: false, message: "Invalid store ID" });
      return;
    }

    if (storeSlug) {
      const store = await prisma.stores.findUnique({
        where: { slug: storeSlug as string },
        select: { id: true },
      });
      if (!store) {
        res.status(404).json({ success: false, message: "Store not found" });
        return;
      }
      targatStoreId = store.id;
    }

    if (!targatStoreId) {
      res
        .status(400)
        .json({ success: false, message: "storeId or storeSlug is required" });
      return;
    }

    const init = await prisma.categories.findMany({
      where: { store_id: targatStoreId },
      include: { _count: { select: { products: true } } },
      orderBy: { name: "asc" },
    });

    const categories = init.map(({ _count, ...rest }) => ({
      ...rest,
      product_count: _count.products,
    }));

    res.status(200).json({ success: true, categories });
  } catch (error: any) {
    console.error("getCategories error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch categories",
    });
  }
};

export const createCategories = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { name, storeId: requestedStoreId } = req.body ?? {};
    const storeId = parseId(requestedStoreId);

    if (storeId === null) {
      res.status(400).json({ success: false, message: "Invalid store ID" });
      return;
    }

    if (typeof name !== "string" || !name.trim()) {
      res
        .status(400)
        .json({ success: false, message: "Category name is required" });
      return;
    }

    const store = await getStore(req.user!.id, storeId);
    if (!store) {
      res.status(404).json({ success: false, message: "Store not found" });
      return;
    }

    const category = await prisma.categories.create({
      data: { store_id: store.id, name: name.trim(), slug: generateSlug(name) },
    });

    res
      .status(201)
      .json({ success: true, message: "Category created", category });
  } catch (error: any) {
    console.error("createCategories error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create category",
    });
  }
};

export const deleteCategories = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const storeId = parseId(req.query.storeId);
    const categoryId = parseId(req.params.id);

    if (storeId === null || categoryId === null) {
      res
        .status(400)
        .json({ success: false, message: "Invalid category or store ID" });
      return;
    }

    const store = await getStore(req.user!.id, storeId);

    if (!store) {
      res.status(404).json({ success: false, message: "Store not found" });
      return;
    }

    await prisma.categories.deleteMany({
      where: { id: categoryId, store_id: store.id },
    });

    res
      .status(200)
      .json({ success: true, message: "Category deleted successfully" });
  } catch (error: any) {
    console.error("deleteCategories error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete category",
    });
  }
};
