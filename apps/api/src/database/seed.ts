import { and, eq } from 'drizzle-orm';
import { requireEnv } from '../env.js';
import { createDatabase } from './client.js';
import { orgUnits, tenants } from './schema.js';

type UnitSeed = {
  type: 'facility' | 'department' | 'unit';
  code: string;
  nameEn: string;
  nameAr: string;
  children?: UnitSeed[];
};

const hospitalStructure = (code: string): UnitSeed => ({
  type: 'facility',
  code,
  nameEn: 'Main Hospital',
  nameAr: 'المستشفى الرئيسي',
  children: [
    {
      type: 'department',
      code: `${code}-QM`,
      nameEn: 'Quality Management',
      nameAr: 'إدارة الجودة',
    },
    {
      type: 'department',
      code: `${code}-NUR`,
      nameEn: 'Nursing',
      nameAr: 'التمريض',
      children: [
        {
          type: 'unit',
          code: `${code}-NUR-ICU`,
          nameEn: 'Intensive Care Unit',
          nameAr: 'وحدة العناية المركزة',
        },
        {
          type: 'unit',
          code: `${code}-NUR-MED`,
          nameEn: 'Medical Ward',
          nameAr: 'جناح الباطنية',
        },
      ],
    },
    {
      type: 'department',
      code: `${code}-ER`,
      nameEn: 'Emergency',
      nameAr: 'الطوارئ',
    },
    {
      type: 'department',
      code: `${code}-PHA`,
      nameEn: 'Pharmacy',
      nameAr: 'الصيدلية',
    },
  ],
});

// Two fictional pilot-shaped hospitals, one per accreditation standard.
const demoTenants = [
  {
    slug: 'demo-jci',
    nameEn: 'Demo Hospital A',
    nameAr: 'المستشفى التجريبي أ',
    accreditationStandard: 'JCI' as const,
    defaultLocale: 'en',
    structure: hospitalStructure('DHA'),
  },
  {
    slug: 'demo-cbahi',
    nameEn: 'Demo Hospital B',
    nameAr: 'المستشفى التجريبي ب',
    accreditationStandard: 'CBAHI' as const,
    defaultLocale: 'ar',
    structure: hospitalStructure('DHB'),
  },
];

/** Inserts the demo tenants as the owner role. Safe to run repeatedly. */
export async function seed() {
  const { pool, db } = createDatabase(requireEnv('DATABASE_URL'));
  try {
    for (const { structure, ...tenant } of demoTenants) {
      await db.transaction(async (tx) => {
        await tx
          .insert(tenants)
          .values(tenant)
          .onConflictDoNothing({ target: tenants.slug });
        const [{ id: tenantId }] = await tx
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.slug, tenant.slug));

        const insertUnit = async (unit: UnitSeed, parentId: string | null) => {
          const { children = [], ...values } = unit;
          await tx
            .insert(orgUnits)
            .values({ ...values, tenantId, parentId })
            .onConflictDoNothing({
              target: [orgUnits.tenantId, orgUnits.code],
            });
          const [{ id }] = await tx
            .select({ id: orgUnits.id })
            .from(orgUnits)
            .where(
              and(eq(orgUnits.tenantId, tenantId), eq(orgUnits.code, unit.code)),
            );
          for (const child of children) await insertUnit(child, id);
        };
        await insertUnit(structure, null);
      });
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await seed();
  console.log('Demo tenants seeded.');
}
