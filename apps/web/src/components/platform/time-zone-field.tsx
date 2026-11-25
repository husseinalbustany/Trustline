"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Field, inputClass } from "@/components/ui/field";
import { dateTimeFormat, fill } from "@/lib/format";
import { timeZoneNames, zoneLabel } from "@/lib/time-zone";
import { useMinute } from "@/lib/use-minute";

export type TimeZoneText = {
  label: string;
  help: string;
  /** Names the list of matches for a screen reader. */
  list: string;
  /** "Time there now: {time} ({zone})" */
  now: string;
  none: string;
};

/**
 * The clock of each zone in the list, made once: the list is some four
 * hundred names long and is drawn again at every key press.
 */
const clocks = new Map<string, Intl.DateTimeFormat>();
function clockIn(lang: string, timeZone: string) {
  const key = `${lang} ${timeZone}`;
  let clock = clocks.get(key);
  if (!clock) {
    clock = dateTimeFormat(lang, timeZone, {
      hour: "numeric",
      minute: "2-digit",
    });
    clocks.set(key, clock);
  }
  return clock;
}

/** Typed loosely: "new york" finds `America/New_York`. */
const loose = (text: string) =>
  text
    .toLowerCase()
    .replace(/[\s_/]+/g, " ")
    .trim();

/**
 * Chooses a hospital's time zone from the names this browser knows, by
 * typing part of one. A combo box in the usual sense: arrows move through
 * the matches, Enter takes one, Escape puts back what was chosen. Under it,
 * the time it is there now, so the choice can be checked by eye.
 *
 * The ids are made by React for this one field: they tie the box to its
 * list for a screen reader, and cannot repeat on a page kept mounted
 * behind this one.
 */
export function TimeZoneField({
  lang,
  t,
  value,
  onChange,
}: {
  lang: string;
  t: TimeZoneText;
  /** The zone chosen: an IANA name. */
  value: string;
  onChange: (timeZone: string) => void;
}) {
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // What is typed while searching; null when the field shows the choice.
  const [typed, setTyped] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const now = useMinute();
  const names = useMemo(() => timeZoneNames(), []);

  const open = typed !== null;
  const matches = useMemo(() => {
    const wanted = loose(typed ?? "");
    return wanted
      ? names.filter((name) => loose(name).includes(wanted))
      : names;
  }, [names, typed]);
  const optionId = (index: number) => `${listId}-${index}`;

  const moveTo = (index: number) => {
    if (matches.length === 0) return;
    const next = (index + matches.length) % matches.length;
    setActive(next);
    // Kept in view as the arrows move through a long list.
    list.current?.children[next]?.scrollIntoView({ block: "nearest" });
  };
  const close = () => setTyped(null);
  // Back to showing the choice, with all of it selected: whatever is typed
  // next starts a new search instead of being added to the name.
  const settle = () => {
    close();
    requestAnimationFrame(() => {
      if (document.activeElement === input.current) input.current?.select();
    });
  };
  const choose = (name: string) => {
    onChange(name);
    settle();
  };
  const search = (text: string) => {
    setTyped(text);
    setActive(0);
  };

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      // The first press opens the list at the zone already chosen.
      if (!open) {
        setTyped("");
        const at = Math.max(0, names.indexOf(value));
        setActive(at);
        requestAnimationFrame(() =>
          list.current?.children[at]?.scrollIntoView({ block: "nearest" }),
        );
      } else moveTo(active + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter" && open) {
      // Takes the match; without the list open, Enter sends the form.
      e.preventDefault();
      if (matches[active]) choose(matches[active]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      settle();
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <Field label={t.label}>
          <input
            ref={input}
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              open && matches[active] ? optionId(active) : undefined
            }
            dir="ltr"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={typed ?? value}
            onChange={(e) => search(e.target.value)}
            // Everything is selected, so typing replaces the name shown.
            onFocus={(e) => e.target.select()}
            onClick={() => !open && search("")}
            // Leaving without choosing puts back what was chosen.
            onBlur={close}
            onKeyDown={onKeyDown}
            className={inputClass}
          />
        </Field>
        {open && (
          <ul
            ref={list}
            id={listId}
            role="listbox"
            aria-label={t.list}
            className="absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-md border border-line bg-background py-1 text-sm shadow-lg"
          >
            {matches.map((name, index) => (
              <li
                key={name}
                id={optionId(index)}
                role="option"
                aria-selected={name === value}
                // Keeps the field focused, so the click is not lost to its
                // blur closing the list first.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(name)}
                onMouseEnter={() => setActive(index)}
                className={`flex cursor-pointer items-baseline justify-between gap-3 px-3 py-1.5 ${
                  index === active ? "bg-accent-soft text-accent" : ""
                } ${name === value ? "font-medium" : ""}`}
              >
                <bdi dir="ltr">{name}</bdi>
                {now && (
                  <span className="shrink-0 text-xs text-muted tabular-nums">
                    {clockIn(lang, name).format(now)}
                  </span>
                )}
              </li>
            ))}
            {matches.length === 0 && (
              <li className="px-3 py-2 text-muted">{t.none}</li>
            )}
          </ul>
        )}
      </div>
      <p className="text-xs text-muted">{t.help}</p>
      {/* Read out when the choice changes, for someone who cannot see it. */}
      <p role="status" className="text-sm">
        {now &&
          fill(t.now, {
            time: dateTimeFormat(lang, value, {
              weekday: "short",
              day: "numeric",
              month: "short",
              hour: "numeric",
              minute: "2-digit",
            }).format(now),
            zone: zoneLabel(lang, value, now),
          })}
      </p>
    </div>
  );
}
