import { prisma } from "../config/prisma.js";

export interface NeonUserRecord {
  id: string;
  name: string | null;
  email: string;
  role: string | null;
  createdAT?: Date | null;
}

export const findNeonUser = async (filter: {
  id?: string;
  email?: string;
}): Promise<NeonUserRecord | null> => {
  try {
    if (filter.id) {
      const rows = await prisma.$queryRaw<NeonUserRecord[]>`
            SELECT id, name, email, role, "createdAt" as "createdAt"
            FROM neon_auth_user
            WHERE id = ${filter.id}::uuid
            LIMIT 1;
            `;

      return rows[0] || null;
    }

    if (filter.email) {
      const rows = await prisma.$queryRaw<NeonUserRecord[]>`
            SELECT id, name, email, role, "createdAt" as "createdAt"
            FROM neon_auth_user
            WHERE LOWER(email) = ${filter.email?.trim().toLocaleLowerCase()}
            LIMIT 1;
            `;

      return rows[0] || null;
    }
  } catch (e) {
    console.error(e);
  }
  return null;
};
