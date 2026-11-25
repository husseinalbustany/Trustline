"use client";

import { Printer } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { CopyLink } from "@/components/ui/copy-link";
import { Panel } from "@/components/ui/panel";
import { direction } from "@/i18n/config";
import { fill } from "@/lib/format";
import { publicReportUrl, type OrgUnit } from "@/lib/identity";
import { pick, type Localized } from "@/lib/localized";
import type { AdminProps } from "./types";

type Props = AdminProps & {
  unit: OrgUnit;
  /** The line of instruction under the code, in each interface language. */
  posterLines: Record<string, string>;
};

/** The hospital's languages, its own first. */
const languagesOf = (tenant: { locales: string[]; defaultLocale: string }) => [
  tenant.defaultLocale,
  ...tenant.locales.filter((locale) => locale !== tenant.defaultLocale),
];

/**
 * A unit's own link to the report form, with the unit already chosen, and
 * the same link as a QR code to print and put up on the ward. Shown while
 * the hospital takes reports without sign-in.
 */
export function UnitReporting({ lang, t, unit }: Props) {
  const session = useSession();
  const r = t.organization.reporting;
  const url = publicReportUrl(session.tenant.slug, unit.id);

  return (
    <Panel title={r.title}>
      <div className="flex flex-col gap-4 p-4">
        <p className="text-sm text-muted">
          {fill(r.help, {
            name: pick(unit.name, lang, session.tenant.defaultLocale),
          })}
        </p>
        <CopyLink
          label={r.link}
          url={url}
          t={{ copy: r.copy, copied: r.copied }}
        />
        <div className="flex flex-wrap items-end gap-4">
          {/* Black on white whatever the screen is set to: a phone's camera
              needs the contrast. */}
          <QRCodeSVG
            value={url}
            size={144}
            marginSize={2}
            title={r.qrLabel}
            className="rounded-md border border-line"
          />
          <div className="flex flex-col items-start gap-2">
            <Button variant="secondary" onClick={() => window.print()}>
              <Printer className="size-4" aria-hidden />
              {r.print}
            </Button>
            <p className="max-w-56 text-xs text-muted">{r.printHelp}</p>
          </div>
        </div>
      </div>
    </Panel>
  );
}

/**
 * What goes on paper in place of the unit's page: the hospital, the unit,
 * the QR code and one line saying what to do, in each of the hospital's
 * languages. Not shown on screen.
 */
export function UnitPoster({ unit, posterLines }: Props) {
  const { tenant } = useSession();
  const languages = languagesOf(tenant);
  // A name is written once per language; the same words are printed once.
  const inEach = (text: Localized) =>
    languages
      .map((locale) => ({ locale, words: text[locale] }))
      .filter(
        (line, index, all): line is { locale: string; words: string } =>
          !!line.words &&
          all.findIndex((other) => other.words === line.words) === index,
      );
  const lines = (text: Localized, className: string) =>
    inEach(text).map(({ locale, words }) => (
      <p
        key={locale}
        lang={locale}
        dir={direction(locale)}
        className={className}
      >
        {words}
      </p>
    ));

  return (
    <div className="hidden min-h-[24cm] flex-col items-center justify-center gap-10 text-center text-black print:flex">
      <div className="flex flex-col gap-1">
        {lines(tenant.name, "text-2xl font-medium")}
      </div>
      <div className="flex flex-col gap-1">
        {lines(unit.name, "text-4xl font-bold")}
      </div>
      <QRCodeSVG
        value={publicReportUrl(tenant.slug, unit.id)}
        size={360}
        marginSize={4}
        className="size-[10cm]"
      />
      <div className="flex max-w-[15cm] flex-col gap-3">
        {languages
          .filter((locale) => posterLines[locale])
          .map((locale) => (
            <p
              key={locale}
              lang={locale}
              dir={direction(locale)}
              className="text-xl"
            >
              {posterLines[locale]}
            </p>
          ))}
      </div>
    </div>
  );
}
