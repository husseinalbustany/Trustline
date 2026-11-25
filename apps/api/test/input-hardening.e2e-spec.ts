import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type request from 'supertest';
import {
  testBench,
  type Hospital,
  type TestBench,
} from './support/hospital.js';

/**
 * What a client may write, on every route that takes a name, a code or who
 * is asking: no control characters, which the database either refuses (and
 * the API then answered with a 500) or stores where nobody can see them; and
 * everything Arabic and French are written with.
 */
describe('what a client may write', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  const http = () => bench.http();
  let h: Hospital; // works in English, Arabic and French
  let facility: string;
  let adminEmail: string;

  // Every one by its number: none of these can be seen in a source file.
  const at = (...points: number[]) => String.fromCodePoint(...points);
  const NUL = at(0);
  /** Refused in every text: no keyboard types them, no language needs them. */
  const CONTROLS = [0x00, 0x01, 0x08, 0x0b, 0x1b, 0x1f, 0x7f].map((c) => at(c));
  /** Refused in one line of text besides: line breaks of every kind, C1. */
  const IN_A_LINE = [0x09, 0x0a, 0x0d, 0x85, 0x9b, 0x2028, 0x2029].map((c) =>
    at(c),
  );
  /**
   * The character in the middle of a value. (At either end some of them
   * count as white space, which is dropped where the value is looked up.)
   */
  const within = (value: string, character: string) =>
    `${value.slice(0, 3)}${character}${value.slice(3)}`;
  const named = (character: string) =>
    `U+${character.codePointAt(0)!.toString(16).padStart(4, '0')}`;

  /** What Arabic and French are written with. */
  const ZWNJ = at(0x200c);
  const ZWJ = at(0x200d);
  const RLM = at(0x200f);
  const LRM = at(0x200e);
  const ALM = at(0x061c);
  const NBSP = at(0x00a0);
  const NNBSP = at(0x202f);
  const ARABIC = `${at(0x0645, 0x06cc)}${ZWNJ}${at(0x062e, 0x0648, 0x0627, 0x0647, 0x0645)} ${at(0x0647)}${ZWJ} (ICU)${RLM} ${ALM}3`;
  const FRENCH = `Unit${at(0xe9)} de soins${NBSP}: r${at(0xe9)}animation${NNBSP}? ${at(0xab)}${NBSP}Bloc${LRM} B${NBSP}${at(0xbb)}`;

  const password = `hospital-pass-${run}`;

  beforeAll(async () => {
    bench = await testBench('ih', run);
    h = await bench.createHospital('a', {
      locales: ['en', 'ar', 'fr'],
      defaultLocale: 'en',
    });
    adminEmail = `admin-ih-a-${run}@test.invalid`;
    facility = await bench.createUnit(h, 'facility', 'MAIN', null);
  }, 120_000);

  afterAll(() => bench.close());

  const expectAll = async (
    what: string,
    characters: string[],
    send: (character: string) => request.Test,
    status: number,
  ) => {
    for (const character of characters) {
      const res = await send(character);
      expect([what, named(character), res.status]).toEqual([
        what,
        named(character),
        status,
      ]);
    }
  };

  describe('before anyone is signed in', () => {
    const login = (body: Record<string, unknown>) =>
      http().post('/auth/login').send(body);

    it('refuses a control character in the organization or the email, the same whether or not the hospital exists', async () => {
      for (const character of [...CONTROLS, at(0x0a), at(0x85)]) {
        const email = `admin${character}@test.invalid`;
        // With a NUL in the email this was a 500 for a hospital that exists
        // and takes passwords, and a 401 for any other: it told them apart.
        const here = await login({ org: h.slug, email, password });
        const nowhere = await login({
          org: `no-such-org-${run}`,
          email,
          password,
        });
        expect([named(character), here.status, nowhere.status]).toEqual([
          named(character),
          400,
          400,
        ]);
        expect(here.body).toEqual(nowhere.body);
        expect(here.body).toEqual({ statusCode: 400, message: 'Bad Request' });
        expect(here.get('Set-Cookie')).toBeUndefined();
        // In the organization: malformed too, before anything is looked up.
        for (const org of [within(h.slug, character), `no${character}such`]) {
          const res = await login({ org, email: adminEmail, password });
          expect([named(character), res.status]).toEqual([
            named(character),
            400,
          ]);
        }
      }
    });

    it('still signs in someone whose details came with spaces or a line end around them', async () => {
      await login({
        org: ` ${h.slug.toUpperCase()}\r\n`,
        email: `\t${adminEmail.toUpperCase()} \n`,
        password,
      }).expect(200);
      // And refuses a wrong password, or anything in the password, as ever.
      await login({ org: h.slug, email: adminEmail, password: 'wrong' }).expect(
        401,
      );
      for (const org of [h.slug, `no-such-org-${run}`]) {
        await login({
          org,
          email: adminEmail,
          password: `${NUL}${password}`,
        }).expect(401);
      }
    });

    it('refuses a control character in the organization of a set-password link the same way', async () => {
      const token = randomBytes(32).toString('base64url');
      for (const character of [...CONTROLS, at(0x0a)]) {
        for (const org of [within(h.slug, character), `no${character}such`]) {
          const checked = await http()
            .post('/auth/invite/check')
            .send({ org, token });
          const accepted = await http()
            .post('/auth/invite/accept')
            .send({ org, token, password: `new-pass-${run}-long` });
          expect([named(character), checked.status, accepted.status]).toEqual([
            named(character),
            400,
            400,
          ]);
        }
      }
      // The link itself is never looked up as written: whatever it holds,
      // it is one that does not exist, here and in a hospital that does not.
      for (const org of [h.slug, `no-such-org-${run}`]) {
        await http()
          .post('/auth/invite/check')
          .send({ org, token: `${token}${NUL}` })
          .expect(404);
        await http()
          .post('/auth/invite/accept')
          .send({ org, token: `${NUL}`, password: `new-pass-${run}-long` })
          .expect(404);
      }
    });

    it('refuses a control character in the email of the admin portal sign-in', async () => {
      await expectAll(
        'email',
        [...CONTROLS, at(0x0a)],
        (character) =>
          http()
            .post('/platform/auth/login')
            .send({ email: `staff${character}@test.invalid`, password }),
        400,
      );
      await http()
        .post('/platform/auth/login')
        .send({ email: 'nobody@test.invalid', password: `x${NUL}y` })
        .expect(401);
    });
  });

  describe('a user', () => {
    const create = (fields: Record<string, unknown>) =>
      http()
        .post('/users')
        .set('Cookie', h.cookie)
        .send({
          name: { en: 'Nadia' },
          email: `user-${randomBytes(4).toString('hex')}-${run}@test.invalid`,
          roles: [],
          ...fields,
        });

    it('cannot be given a name, title, number or phone with a control character or a line break', async () => {
      const made = await create({}).expect(201);
      const id = made.body.user.id as string;
      const edit = (fields: Record<string, unknown>) =>
        http().patch(`/users/${id}`).set('Cookie', h.cookie).send(fields);
      for (const [field, value] of [
        ['name', (c: string) => ({ en: `Na${c}dia` })],
        [
          'name',
          (c: string) => ({ en: 'Nadia', ar: `${ARABIC}${c}${ARABIC}` }),
        ],
        ['jobTitle', (c: string) => `Head${c}nurse`],
        ['employeeNumber', (c: string) => `E-${c}17`],
        ['phone', (c: string) => `+961${c}1234`],
      ] as const) {
        const all = [...CONTROLS, ...IN_A_LINE];
        await expectAll(field, all, (c) => create({ [field]: value(c) }), 400);
        await expectAll(field, all, (c) => edit({ [field]: value(c) }), 400);
      }
      // An email with one is no email.
      await expectAll(
        'email',
        CONTROLS,
        (c) => create({ email: `na${c}dia-${run}@test.invalid` }),
        400,
      );
      const stored = await bench.owner.db.execute(
        sql`select name, job_title, employee_number, phone from users where id = ${id}`,
      );
      expect(stored.rows[0]).toEqual({
        name: { en: 'Nadia' },
        job_title: null,
        employee_number: null,
        phone: null,
      });
    });

    it('keeps what Arabic and French need, exactly as written', async () => {
      const name = { en: `Zo${at(0xe9)}${NBSP}Dupont`, ar: ARABIC, fr: FRENCH };
      const made = await create({
        name,
        jobTitle: `  ${FRENCH}  `,
        employeeNumber: `${ARABIC}`,
        phone: `+961${NBSP}1${NNBSP}234`,
      }).expect(201);
      const read = await http()
        .get(`/users/${made.body.user.id}`)
        .set('Cookie', h.cookie)
        .expect(200);
      expect(read.body).toMatchObject({
        name,
        jobTitle: FRENCH,
        employeeNumber: ARABIC,
        phone: `+961${NBSP}1${NNBSP}234`,
      });
    });
  });

  describe('a role', () => {
    const create = (fields: Record<string, unknown>) =>
      http()
        .post('/roles')
        .set('Cookie', h.cookie)
        .send({
          code: `role_${randomBytes(4).toString('hex')}`,
          name: { en: 'Night shift lead' },
          permissions: ['incidents.report'],
          ...fields,
        });

    it('cannot be given a name with a control character or a line break, nor a description with a control character', async () => {
      const made = await create({}).expect(201);
      const edit = (fields: Record<string, unknown>) =>
        http()
          .patch(`/roles/${made.body.id}`)
          .set('Cookie', h.cookie)
          .send(fields);
      const all = [...CONTROLS, ...IN_A_LINE];
      const name = (c: string) => ({ name: { en: `Night${c}lead` } });
      const description = (c: string) => ({
        description: { en: `For${c}nights` },
      });
      await expectAll('name', all, (c) => create(name(c)), 400);
      await expectAll('name', all, (c) => edit(name(c)), 400);
      await expectAll(
        'description',
        CONTROLS,
        (c) => create(description(c)),
        400,
      );
      await expectAll(
        'description',
        CONTROLS,
        (c) => edit(description(c)),
        400,
      );
      // Its code was never anything but small letters, digits and "_".
      await expectAll(
        'code',
        [...all, RLM, NBSP],
        (c) => create({ code: `night${c}lead` }),
        400,
      );
      await create({ code: `night_lead${at(0x0a)}` }).expect(400);
      const stored = await bench.owner.db.execute(
        sql`select name, description from roles where id = ${made.body.id}`,
      );
      expect(stored.rows[0]).toEqual({
        name: { en: 'Night shift lead' },
        description: null,
      });
    });

    it('keeps a description of several lines, and what Arabic and French need', async () => {
      const lines = `Leads the night shift.\nReports incidents;\tcloses none.`;
      const made = await create({
        name: { en: 'Lead', ar: ARABIC, fr: FRENCH },
        description: { en: lines, ar: ARABIC, fr: FRENCH },
      }).expect(201);
      expect(made.body).toMatchObject({
        name: { en: 'Lead', ar: ARABIC, fr: FRENCH },
        description: { en: lines, ar: ARABIC, fr: FRENCH },
      });
    });
  });

  describe('an org unit', () => {
    const create = (fields: Record<string, unknown>) =>
      http()
        .post('/org-units')
        .set('Cookie', h.cookie)
        .send({
          type: 'department',
          code: `D-${randomBytes(3).toString('hex').toUpperCase()}`,
          name: { en: 'Pharmacy' },
          parentId: facility,
          ...fields,
        });

    it('cannot be given a name or a code with a control character or a line break', async () => {
      const made = await create({}).expect(201);
      const all = [...CONTROLS, ...IN_A_LINE];
      const name = (c: string) => ({ name: { en: `Phar${c}macy` } });
      await expectAll('name', all, (c) => create(name(c)), 400);
      await expectAll(
        'name',
        all,
        (c) =>
          http()
            .patch(`/org-units/${made.body.id}`)
            .set('Cookie', h.cookie)
            .send(name(c)),
        400,
      );
      await expectAll(
        'code',
        [...all, RLM, NBSP],
        (c) => create({ code: `PHA${c}RM` }),
        400,
      );
      await create({ code: `PHARM${at(0x0a)}` }).expect(400);
      const stored = await bench.owner.db.execute(
        sql`select name from org_units where id = ${made.body.id}`,
      );
      expect(stored.rows[0]).toEqual({ name: { en: 'Pharmacy' } });
    });

    it('keeps what Arabic and French need, exactly as written', async () => {
      const name = { en: 'Intensive care', ar: ARABIC, fr: FRENCH };
      const made = await create({ name }).expect(201);
      expect(made.body.name).toEqual(name);
      const list = await http()
        .get('/org-units')
        .set('Cookie', h.cookie)
        .expect(200);
      expect(
        (list.body as { id: string; name: unknown }[]).find(
          (unit) => unit.id === made.body.id,
        )?.name,
      ).toEqual(name);
    });
  });

  describe('a client, in the admin portal', () => {
    const settings = {
      name: { en: 'Hospital' },
      accreditationStandard: 'JCI',
      locales: ['en', 'ar', 'fr'],
      defaultLocale: 'en',
      plan: 'professional',
      signInMethod: 'password',
      dataRegion: null,
    };
    let made = 0;
    const create = (fields: Record<string, unknown>) =>
      http()
        .post('/platform/tenants')
        .set('Cookie', bench.platform)
        .send({ slug: `${bench.prefix}-c${made++}`, ...settings, ...fields });
    const edit = (fields: Record<string, unknown>) =>
      http()
        .patch(`/platform/tenants/${h.id}`)
        .set('Cookie', bench.platform)
        .send(fields);

    it('cannot be given a name, a data region or an identifier with a control character or a line break', async () => {
      const before = await http()
        .get(`/platform/tenants/${h.id}`)
        .set('Cookie', bench.platform)
        .expect(200);
      const all = [...CONTROLS, ...IN_A_LINE];
      const name = (c: string) => ({ name: { en: `Hos${c}pital` } });
      const region = (c: string) => ({ dataRegion: `eu${c}west` });
      await expectAll('name', all, (c) => create(name(c)), 400);
      await expectAll('name', all, (c) => edit(name(c)), 400);
      await expectAll('dataRegion', all, (c) => create(region(c)), 400);
      await expectAll('dataRegion', all, (c) => edit(region(c)), 400);
      await expectAll(
        'slug',
        [...all, RLM],
        (c) => create({ slug: `${bench.prefix}-x${c}y` }),
        400,
      );
      await create({ slug: `${bench.prefix}-nl${at(0x0a)}` }).expect(400);
      // Its first administrator: the same rules as any user's name.
      await expectAll(
        'administrator',
        all,
        (c) =>
          http()
            .post(`/platform/tenants/${h.id}/administrators`)
            .set('Cookie', bench.platform)
            .send({
              name: { en: `Ad${c}min` },
              email: `second-${run}@test.invalid`,
            }),
        400,
      );
      const after = await http()
        .get(`/platform/tenants/${h.id}`)
        .set('Cookie', bench.platform)
        .expect(200);
      expect(after.body).toEqual(before.body);
      const strays = await bench.owner.db.execute(
        sql`select slug from tenants where slug like ${`${bench.prefix}-%`} and slug <> ${h.slug}`,
      );
      expect(strays.rows).toEqual([]);
    });

    it('keeps what Arabic and French need, and a data region as written', async () => {
      const name = { en: `H${at(0xf4)}pital${NBSP}A`, ar: ARABIC, fr: FRENCH };
      const res = await create({
        name,
        dataRegion: ` me-central${NBSP}1 `,
      }).expect(201);
      expect(res.body).toMatchObject({
        name,
        dataRegion: `me-central${NBSP}1`,
      });
      expect(
        (await edit({ dataRegion: '   ' }).expect(200)).body.dataRegion,
      ).toBeNull();
    });

    it('stores its time zone in the letter case IANA writes it, whatever was typed', async () => {
      const typed = await edit({ timeZone: 'asia/riyadh' }).expect(200);
      expect(typed.body.timeZone).toBe('Asia/Riyadh');
      const me = await http()
        .get('/auth/me')
        .set('Cookie', h.cookie)
        .expect(200);
      expect(me.body.tenant.timeZone).toBe('Asia/Riyadh');
      const created = await create({ timeZone: 'AFRICA/CASABLANCA' }).expect(
        201,
      );
      expect(created.body.timeZone).toBe('Africa/Casablanca');
      // A second spelling of a zone, as another browser lists it: kept.
      expect(
        (await edit({ timeZone: 'Asia/Kolkata' }).expect(200)).body.timeZone,
      ).toBe('Asia/Kolkata');
      // The same name in the same letter case is no change, and leaves none
      // in the log.
      await edit({ timeZone: 'ASIA/RIYADH' }).expect(200);
      await edit({ timeZone: 'Asia/Riyadh' }).expect(200);
      const audit = await bench.owner.db.execute<{ changes: unknown }>(
        sql`select details -> 'changes' -> 'timeZone' as changes from platform_audit_log
            where target_tenant_id = ${h.id} and action = 'client_updated' and details -> 'changes' ? 'timeZone'
            order by created_at, id`,
      );
      expect(audit.rows.map((r) => r.changes)).toEqual([
        { from: 'UTC', to: 'Asia/Riyadh' },
        { from: 'Asia/Riyadh', to: 'Asia/Kolkata' },
        { from: 'Asia/Kolkata', to: 'Asia/Riyadh' },
      ]);
    });

    it('takes no offset for a time zone, under any spelling', async () => {
      for (const timeZone of [
        'Etc/GMT+3',
        'Etc/GMT-3',
        'etc/gmt+3',
        'Etc/GMT0',
        'Etc/UTC',
        'Etc/Zulu',
        'GMT+3',
        '+03:00',
        'asia/kolkata',
        `Asia/Riyadh${NUL}`,
        `Asia/Ri${RLM}yadh`,
      ]) {
        for (const res of [
          await edit({ timeZone }),
          await create({ timeZone }),
        ]) {
          expect([timeZone, res.status, res.body.code]).toEqual([
            timeZone,
            400,
            'unknown_time_zone',
          ]);
        }
      }
      const read = await http()
        .get(`/platform/tenants/${h.id}`)
        .set('Cookie', bench.platform)
        .expect(200);
      expect(read.body.timeZone).toBe('Asia/Riyadh');
    });
  });
});
