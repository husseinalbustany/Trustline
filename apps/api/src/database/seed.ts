import { and, eq, sql } from 'drizzle-orm';
import { requireEnv } from '../env.js';
import { createDatabase } from './client.js';
import type { Locale, Localized } from '../i18n/locales.js';
import { SYSTEM_ROLES } from '../identity/permissions.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import type { EntitlementsService } from '../subscriptions/entitlements.service.js';
import { seedDocuments } from './seed-documents.js';
import { DEFAULT_INCIDENT_CATEGORIES } from '../incidents/categories.js';
import {
  DEFAULT_RESPONSE_RULES,
  HARM_LEVELS,
} from '../incidents/response-rules.js';
import { MODULES, type Extras, type Limits } from '../subscriptions/modules.js';
import {
  incidentCategories,
  incidentResponseRules,
  orgUnits,
  plans,
  roles,
  subscriptions,
  tenants,
} from './schema.js';

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

const NO_EXTRAS: Extras = {
  sso: false,
  publicReporting: false,
  clinicalAiSuggestions: false,
};

/** What every illustrative plan says of itself, after what it holds. */
const ILLUSTRATIVE = {
  en: 'Illustrative: the business sets the real plans, contents and limits.',
  ar: 'للتوضيح فقط: تحدد الإدارة الخطط الفعلية ومحتواها وحدودها.',
  fr: 'À titre d’exemple : les vraies offres, leur contenu et leurs limites sont fixés par l’entreprise.',
};

const illustrated = (en: string, ar: string, fr: string) => ({
  en: `${en} ${ILLUSTRATIVE.en}`,
  ar: `${ar} ${ILLUSTRATIVE.ar}`,
  fr: `${fr} ${ILLUSTRATIVE.fr}`,
});

/**
 * The four plans of the spec's example (docs/specs/modules-and-subscriptions.md),
 * to show the shape. Not offers: names, contents and limits are for the
 * business to set, and none has a price.
 */
const demoPlans: {
  code: string;
  name: Record<Locale, string>;
  description: Record<Locale, string>;
  modules: string[];
  limits: Limits;
  extras: Extras;
  position: number;
}[] = [
  {
    code: 'documents',
    name: { en: 'Documents', ar: 'الوثائق', fr: 'Documents' },
    description: illustrated(
      'Policies and procedures.',
      'السياسات والإجراءات.',
      'Politiques et procédures.',
    ),
    modules: ['policies'],
    limits: { users: 100, sites: 1, storageMb: 5_000, aiCreditsPerMonth: 0 },
    extras: NO_EXTRAS,
    position: 10,
  },
  {
    code: 'learning',
    name: { en: 'Learning', ar: 'التعلّم', fr: 'Formation' },
    description: illustrated(
      'Training and awareness.',
      'التدريب والتوعية.',
      'Formation et sensibilisation.',
    ),
    modules: ['training'],
    limits: { users: 200, sites: 1, storageMb: 10_000, aiCreditsPerMonth: 0 },
    extras: NO_EXTRAS,
    position: 20,
  },
  {
    code: 'safety',
    name: { en: 'Safety', ar: 'السلامة', fr: 'Sécurité' },
    description: illustrated(
      'Incidents and the actions that follow them.',
      'الحوادث والإجراءات التي تليها.',
      'Les incidents et les actions qui en découlent.',
    ),
    modules: ['incidents', 'actions'],
    limits: { users: 250, sites: 3, storageMb: 10_000, aiCreditsPerMonth: 0 },
    extras: { ...NO_EXTRAS, publicReporting: true },
    position: 30,
  },
  {
    code: 'complete',
    name: { en: 'Complete', ar: 'الشاملة', fr: 'Complète' },
    description: illustrated(
      'Every module, with an AI allowance.',
      'كل الوحدات مع رصيد للذكاء الاصطناعي.',
      'Tous les modules, avec un crédit d’IA.',
    ),
    modules: [...MODULES],
    limits: {
      users: null,
      sites: null,
      storageMb: 50_000,
      aiCreditsPerMonth: 500,
    },
    extras: { ...NO_EXTRAS, sso: true, publicReporting: true },
    position: 40,
  },
];

/**
 * Inserts the demo tenants and the illustrative plans as the owner role.
 * Safe to run repeatedly.
 */
export async function seed() {
  const { pool, db } = createDatabase(requireEnv('DATABASE_URL'));
  try {
    for (const plan of demoPlans) {
      // Re-seeding brings them in line with the code: they are examples.
      await db
        .insert(plans)
        .values(plan)
        .onConflictDoUpdate({
          target: plans.code,
          set: {
            name: sql`excluded.name`,
            description: sql`excluded.description`,
            modules: sql`excluded.modules`,
            limits: sql`excluded.limits`,
            extras: sql`excluded.extras`,
            position: sql`excluded.position`,
          },
        });
    }
    const [complete] = await db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.code, 'complete'));

    // Only what needs no entitlements: the module's starting data.
    const provisioning = new ProvisioningService({} as EntitlementsService);
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

        // On the plan with every module. A demo hospital that already has a
        // subscription keeps it, whatever it was changed to.
        await tx
          .insert(subscriptions)
          .values({
            tenantId,
            planId: complete.id,
            status: 'active',
            startsOn: new Date().toISOString().slice(0, 10),
          })
          .onConflictDoNothing({ target: subscriptions.tenantId });

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

        // The starting response rules, kept as they are once a hospital has
        // changed them.
        await tx
          .insert(incidentResponseRules)
          .values(
            HARM_LEVELS.map((harmLevel) => ({
              ...DEFAULT_RESPONSE_RULES[harmLevel],
              harmLevel,
              tenantId,
            })),
          )
          .onConflictDoNothing({
            target: [
              incidentResponseRules.tenantId,
              incidentResponseRules.harmLevel,
            ],
          });

        // The policies module's types, categories and routes, as a new
        // client gets them, and a few example documents in different
        // states. Both leave alone what is there already.
        await provisioning.ensurePolicyDefaults(tx, tenantId);
        const [{ timeZone }] = await tx
          .select({ timeZone: tenants.timeZone })
          .from(tenants)
          .where(eq(tenants.id, tenantId));
        await seedDocuments(tx, {
          id: tenantId,
          locales: tenant.locales,
          timeZone,
          qualityUnitCode: `${structure.code}-QM`,
        });
      });
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  await seed();
  console.log('Demo tenants and illustrative plans seeded.');
}
