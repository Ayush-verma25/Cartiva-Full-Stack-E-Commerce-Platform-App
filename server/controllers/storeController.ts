import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";


// Create a new store (for authenticated merchant)
export const createStore = async (req: AuthenticatedRequest, res: Response) : Promise<void> => {

}

// Get authenticated merchant's store
export const getMyStore = async (req: AuthenticatedRequest, res: Response) : Promise<void> => {

}

// onboard or elevate user to merchant role
export const onboardMerchant = async (req: AuthenticatedRequest, res: Response) : Promise<void> => {

}

// UPdate merchant's store settings
export const updateMyStore = async (req: AuthenticatedRequest, res: Response) : Promise<void> => {

}

// Platform Admin: Get all stores with stats
export const getAllStores = async (_req: AuthenticatedRequest, res: Response) : Promise<void> => {

}

// Platform Admin: Get all merchants
export const getAllMerchants = async (_req: AuthenticatedRequest, res: Response) : Promise<void> => {

}

// Platform Admin: Toggle store status (active / suspended)
export const toggelStoreStatus = async (req: AuthenticatedRequest, res: Response) : Promise<void> => {

}