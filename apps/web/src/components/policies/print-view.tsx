"use client";

import { Printer } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/panel";
import { api, statusOf } from "@/lib/api";
import {
  documentPath,
  shownLanguage,
  type DocumentVersion,
  type PolicyDocument,
} from "@/lib/policies";
import { ControlledDocument } from "./controlled-document";
import type { PoliciesProps } from "./types";

/**
 * A version for paper: the control block and the sections, in the
 * reader's language (or the one chosen on the document), with "Printed
 * copies are not controlled" at the top and the foot.
 */
export function PrintView({ lang, t }: PoliciesProps) {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const asked = params.get("version");
  const askedLanguage = params.get("in");
  const [loaded, setLoaded] = useState<{
    doc: PolicyDocument;
    version: DocumentVersion;
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api<PolicyDocument>(`/policies/documents/${id}`)
      .then(async (doc) => {
        const versionId = asked ?? doc.published?.id;
        if (!versionId) throw new Error("nothing published");
        const version = await api<DocumentVersion>(
          `/policies/documents/${id}/versions/${versionId}`,
        );
        if (!current) return;
        setLoaded({ doc, version });
        setProblem(null);
      })
      .catch(
        (err) =>
          current &&
          setProblem(statusOf(err) === 404 || statusOf(err) === 0 ? t.notFound : t.loadError),
      );
    return () => {
      current = false;
    };
  }, [id, asked, t]);

  const shown = loaded?.doc.id === id ? loaded : null;
  if (problem || !shown) return <EmptyState>{problem ?? t.loading}</EmptyState>;
  const language = shownLanguage(shown.version.languages, askedLanguage, lang);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={documentPath(lang, id)} className="text-sm text-accent hover:underline">
          {t.review.backToDocument}
        </Link>
        <Button onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden />
          {t.document.printNow}
        </Button>
      </div>
      <ControlledDocument
        lang={lang}
        t={t}
        document={shown.doc}
        version={shown.version}
        shown={language}
        printed
      />
    </div>
  );
}
