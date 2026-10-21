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

/**
 * Verifies an EdDSA JWT against the configured Neon issuer, audience, and JWKS,
 * requiring expiration and subject claims. Looks up the user and store by subject;
 * missing user details fall back to token claims or the email local part for name.
 * Admin status from either the user record or token takes precedence, followed by
 * merchant status from either source or store ownership; otherwise uses customer.
 *
 * @param token - JWT without the Bearer prefix.
 * @returns The resolved user with a store ID, or null for that ID when absent or
 * the user is an admin. Returns null for missing configuration, invalid tokens
 * (including non-UUID subjects), or verification and database lookup errors.
 */
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

export const requireAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res
      .status(401)
      .json({ success: false, message: "Unauthorized: No token provided" });
    return;
  }

  const token = authHeader.split(" ")[1];
  const user = await verifyAuthToken(token);

  if (!user) {
    res.status(401).json({
      success: false,
      message: "Unauthorized: Invalid or expired token",
    });
    return;
  }

  req.user = user;
  next();
};

/**
 * Attaches a verified user to req.user for a case-sensitive `Bearer ` header,
 * trimming surrounding token whitespace. Leaves req.user unchanged when the
 * header is absent or authentication fails, then calls next in either case.
 */
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

/**
 * Creates middleware that calls next when req.user has one of the allowed roles.
 * Otherwise sends a 403 JSON response with success: false and
 * "Forbidden: Access denied" without calling next. Does not authenticate tokens;
 * authentication middleware must populate req.user first.
 *
 * @param roles - Allowed roles; an empty array denies every request.
 */
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
