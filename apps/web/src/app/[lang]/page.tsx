import Link from "next/link";
import { notFound } from "next/navigation";
import { hasLocale } from "@/i18n/config";
import { getDictionary } from "@/i18n/dictionaries";

export default async function Home({ params }: PageProps<"/[lang]">) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const dict = await getDictionary(lang);
  const modules = Object.entries(dict.home.modules);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 sm:px-6">
      <header className="flex items-center justify-between border-b border-line py-4">
        <span className="text-lg font-semibold tracking-tight">
          {dict.app.name}
        </span>
        <Link
          href={lang === "ar" ? "/en" : "/ar"}
          className="rounded-md px-3 py-1.5 text-sm text-muted hover:bg-surface hover:text-foreground"
        >
          {dict.app.switchLanguage}
        </Link>
      </header>

      <main className="flex-1 py-12">
        <p className="inline-block rounded-full bg-surface px-3 py-1 text-sm text-muted">
          {dict.home.status}
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
          {dict.app.tagline}
        </h1>
        <p className="mt-3 text-lg text-muted">{dict.home.intro}</p>

        <h2 className="mt-12 text-sm font-medium text-muted">
          {dict.home.modulesTitle}
        </h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {modules.map(([key, item]) => (
            <li key={key} className="rounded-lg border border-line p-4">
              <h3 className="font-medium">{item.title}</h3>
              <p className="mt-1 text-sm text-muted">{item.body}</p>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
