import { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { findNeonUser } from "../services/neonUser.js";
import { prisma } from "../config/prisma.js";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: "admin" | "merchant" | "customer";
  store_id?: number | null;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
}

const NEON_AUTH_JWKS_URL = process.env.NEON_AUTH_JWKS_URL;
const NEON_AUTH_BASE_URL = process.env.NEON_AUTH_BASE_URL;
const NEON_AUTH_AUDIENCE = process.env.NEON_AUTH_AUDIENCE;

let neonJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
let neonIssuer = "";

try {
  if (NEON_AUTH_JWKS_URL) {
    neonJWKS = createRemoteJWKSet(new URL(NEON_AUTH_JWKS_URL));
  }
  if (NEON_AUTH_BASE_URL) {
    neonIssuer = new URL(NEON_AUTH_BASE_URL).origin;
  }
} catch (e) {
  console.warn("Neon Auth JWKS initialization warning:", e);
}

// verifies authentication token using Neon Auth JWKS (jose jwtVerify)
export const verifyAuthToken = async (
  token: string,
): Promise<AuthUser | null> => {
  if (!token || !neonJWKS || !neonIssuer || !NEON_AUTH_AUDIENCE) return null;

  try {
    const { payload } = await jwtVerify(token, neonJWKS, {
      issuer: neonIssuer,
      audience: NEON_AUTH_AUDIENCE,
      algorithms: ["EdDSA"],
      requiredClaims: ["exp", "sub"],
    });
    if (!payload.sub) {
      return null;
    }

    const userEmail = String(payload.email || "").toLowerCase();
    const userId = payload.sub;

    const u = await findNeonUser({ id: userId });

    const effectiveName =
      u?.name || String(payload.name || userEmail.split("@")[0]);
    const effectiveEmail = u?.email || userEmail;
    const store = await prisma.stores.findFirst({
      where: { merchant_id: userId },
    });

    let role: "admin" | "merchant" | "customer" = "customer";
    if (u?.role === "admin" || payload.role === "admin") {
      role = "admin";
    } else if (store || u?.role === "merchant" || payload.role === "merchant") {
      role = "merchant";
    }

    return {
      id: userId,
      name: effectiveName,
      email: effectiveEmail,
      role,
      store_id: role === "admin" ? null : store?.id || null,
    };
  } catch {
    return null;
  }
};

export const optionalAuth = async (
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    const user = await verifyAuthToken(token);
    if (user) {
      req.user = user;
    }
  }
  next();
};

export const requireRole = (
  roles: Array<"admin" | "merchant" | "customer">,
) => {
  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!req.user || !roles.includes(req.user.role)) {
      res
        .status(403)
        .json({ success: false, message: "Forbidden: Access denied" });
      return;
    }
    next();
  };
};
