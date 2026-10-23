import { prisma } from "../config/prisma.js";

export interface NeonUserRecord {
  id: string;
  name: string | null;
  email: string;
  role: string | null;
  createdAt?: Date | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Finds a Neon user by nonempty ID, or by email when no nonempty ID is supplied.
 *
 * @param filter - ID takes precedence over email, even when invalid or unmatched.
 * Email is trimmed and matched case-insensitively.
 * @returns The first matching record, or null when no record matches or both
 * filter values are absent or empty.
 * @throws {TypeError} If a nonempty ID is not a UUID in hyphenated hexadecimal form.
 * @throws Propagates database query errors.
 */
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

export const updateNeonUserRole = async (
  userId: string,
  role: string,
): Promise<void> => {
  try {
    await prisma.$executeRaw`
    UPDATE neon_auth_user
    SET role = ${role}, "updatedAt" = NOW()
    WHERE id = ${userId}::uuid AND (role IS NULL OR role != 'admin')
    `;
  } catch (e) {
    console.error(e);
    throw e;
  }
};

export const findNeonUsersByIds = async (
  ids: string[],
): Promise<Record<string, NeonUserRecord>> => {
  if (!ids || ids.length === 0) return {};
  try {
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    const rows = await prisma.$queryRaw<NeonUserRecord[]>`
    SELECT id, name, email, role, "createdAt" as "createdAt"
    FROM neon_auth_user
    WHERE id::text = ANY(${uniqueIds})
    `;

    const map: Record<string, NeonUserRecord> = {};
    for (const row of rows) {
      map[row.id] = row;
    }

    return map;
  } catch (e) {
    console.error(e);
    return {};
  }
};

export const findNeonMerchants = async (): Promise<NeonUserRecord[]> => {
  try {
    return await prisma.$queryRaw<NeonUserRecord[]>`
    SELECT id, name, email, role, "createdAt" as "createdAt"
    FROM neon_auth_user
    WHERE role = 'merchant'
    ORDER BY "createdAt" DESC`;
  } catch (e) {
    console.error(e);
    throw e;
  }
};

export const countNeonMerchants = async (): Promise<number> => {
  try {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) as count
    FROM neon_auth_user
    WHERE role = 'merchant'
    `;

    return Number(rows[0]?.count || 0);
  } catch (e) {
    console.error(e);
    return 0;
  }
};
