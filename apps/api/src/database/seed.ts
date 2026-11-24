import { and, eq, sql } from 'drizzle-orm';
import { requireEnv } from '../env.js';
import { createDatabase } from './client.js';
import type { Locale, Localized } from '../i18n/locales.js';
import { SYSTEM_ROLES } from '../identity/permissions.js';
import { DEFAULT_INCIDENT_CATEGORIES } from '../incidents/categories.js';
import { incidentCategories, orgUnits, roles, tenants } from './schema.js';

type UnitSeed = {
  type: 'facility' | 'department' | 'unit';
  code: string;
  name: Record<Locale, string>;
  children?: UnitSeed[];
};

const unit = (
  type: UnitSeed['type'],
  code: string,
  en: string,
  ar: string,
  fr: string,
  children?: UnitSeed[],
): UnitSeed => ({ type, code, name: { en, ar, fr }, children });

const hospitalStructure = (code: string): UnitSeed =>
  unit(
    'facility',
    code,
    'Main Hospital',
    'المستشفى الرئيسي',
    'Hôpital principal',
    [
      unit(
        'department',
        `${code}-QM`,
        'Quality Management',
        'إدارة الجودة',
        'Gestion de la qualité',
      ),
      unit(
        'department',
        `${code}-NUR`,
        'Nursing',
        'التمريض',
        'Soins infirmiers',
        [
          unit(
            'unit',
            `${code}-NUR-ICU`,
            'Intensive Care Unit',
            'وحدة العناية المركزة',
            'Unité de soins intensifs',
          ),
          unit(
            'unit',
            `${code}-NUR-MED`,
            'Medical Ward',
            'جناح الباطنية',
            'Service de médecine',
          ),
        ],
      ),
      unit('department', `${code}-ER`, 'Emergency', 'الطوارئ', 'Urgences'),
      unit('department', `${code}-PHA`, 'Pharmacy', 'الصيدلية', 'Pharmacie'),
    ],
  );

/** Keeps only the languages a client uses. */
const inLanguages = (text: Record<Locale, string>, locales: Locale[]) =>
  Object.fromEntries(locales.map((l) => [l, text[l]])) as Localized;

// Three fictional hospitals: one per accreditation standard, and one that
// works in French first, to show a client is not tied to English and Arabic.
const demoTenants: {
  slug: string;
  name: Record<Locale, string>;
  locales: Locale[];
  defaultLocale: Locale;
  accreditationStandard: 'JCI' | 'CBAHI';
  structure: UnitSeed;
}[] = [
  {
    slug: 'demo-jci',
    name: {
      en: 'Demo Hospital A',
      ar: 'المستشفى التجريبي أ',
      fr: 'Hôpital de démonstration A',
    },
    locales: ['en', 'ar'],
    defaultLocale: 'en',
    accreditationStandard: 'JCI',
    structure: hospitalStructure('DHA'),
  },
  {
    slug: 'demo-cbahi',
    name: {
      en: 'Demo Hospital B',
      ar: 'المستشفى التجريبي ب',
      fr: 'Hôpital de démonstration B',
    },
    locales: ['ar', 'en'],
    defaultLocale: 'ar',
    accreditationStandard: 'CBAHI',
    structure: hospitalStructure('DHB'),
  },
  {
    slug: 'demo-fr',
    name: {
      en: 'Demo Hospital C',
      ar: 'المستشفى التجريبي ج',
      fr: 'Hôpital de démonstration C',
    },
    locales: ['fr', 'ar', 'en'],
    defaultLocale: 'fr',
    accreditationStandard: 'JCI',
    structure: hospitalStructure('DHC'),
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
          .values({
            ...tenant,
            name: inLanguages(tenant.name, tenant.locales),
          })
          .onConflictDoNothing({ target: tenants.slug });
        const [{ id: tenantId }] = await tx
          .select({ id: tenants.id })
          .from(tenants)
          .where(eq(tenants.slug, tenant.slug));

        const insertUnit = async (node: UnitSeed, parentId: string | null) => {
          const { children = [], name, ...values } = node;
          await tx
            .insert(orgUnits)
            .values({
              ...values,
              name: inLanguages(name, tenant.locales),
              tenantId,
              parentId,
            })
            .onConflictDoNothing({
              target: [orgUnits.tenantId, orgUnits.code],
            });
          const [{ id }] = await tx
            .select({ id: orgUnits.id })
            .from(orgUnits)
            .where(
              and(
                eq(orgUnits.tenantId, tenantId),
                eq(orgUnits.code, node.code),
              ),
            );
          for (const child of children) await insertUnit(child, id);
        };
        await insertUnit(structure, null);

        await tx
          .insert(roles)
          .values(SYSTEM_ROLES.map((r) => ({ ...r, tenantId, isSystem: true })))
          // Re-seeding brings the built-in roles in line with the code.
          .onConflictDoUpdate({
            target: [roles.tenantId, roles.code],
            set: {
              name: sql`excluded.name`,
              description: sql`excluded.description`,
              permissions: sql`excluded.permissions`,
            },
          });

        // In every language, like the built-in roles. Existing ones are kept
        // as they are, exactly as ProvisioningService does for a new client.
        await tx
          .insert(incidentCategories)
          .values(DEFAULT_INCIDENT_CATEGORIES.map((c) => ({ ...c, tenantId })))
          .onConflictDoNothing({
            target: [incidentCategories.tenantId, incidentCategories.code],
          });
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
