import { prisma } from "../config/prisma.js";

export interface NeonUserRecord {
  id: string;
  name: string | null;
  email: string;
  role: string | null;
  createdAt?: Date | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const findNeonUser = async (filter: {
  id?: string;
  email?: string;
}): Promise<NeonUserRecord | null> => {
  if (filter.id) {
    if (!UUID_PATTERN.test(filter.id)) {
      throw new TypeError("Invalid Neon user UUID");
    }
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
            WHERE LOWER(email) = ${filter.email.trim().toLowerCase()}
            LIMIT 1;
            `;

    return rows[0] || null;
  }
  return null;
};
