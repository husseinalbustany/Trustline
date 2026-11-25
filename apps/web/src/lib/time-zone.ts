/**
 * The hospital's own clock. Every date and time a member of staff sees or
 * types is on the clock of their hospital (`tenant.timeZone`, an IANA name
 * such as `Asia/Riyadh`), not on the clock of the device in their hands: a
 * nurse who travels, or a laptop set to another zone, must not move an
 * incident by hours.
 *
 * A time zone is passed as `string | undefined` everywhere. `deviceTime`
 * (undefined) is the reader's own device, for the pages that belong to no
 * hospital's staff: the public pages and the admin portal.
 */
export type TimeZone = string | undefined;

/** The clock of the device the page is read on. */
export const deviceTime: TimeZone = undefined;

const known = new Map<string, boolean>();

/**
 * The zone to count in. A name this browser does not know (the API's list
 * can be newer than an old browser's) falls back to UTC rather than break
 * the page; `zoneLabel` then says UTC, so what is shown is what is used.
 */
export function usableZone(timeZone: TimeZone): TimeZone {
  if (timeZone === undefined) return undefined;
  let ok = known.get(timeZone);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en", { timeZone });
      ok = true;
    } catch {
      ok = false;
    }
    known.set(timeZone, ok);
  }
  return ok ? timeZone : "UTC";
}

const part = (
  lang: string,
  timeZone: TimeZone,
  timeZoneName: "long" | "shortOffset",
  at: Date,
) =>
  new Intl.DateTimeFormat(
    new Intl.Locale(lang, { numberingSystem: "latn" }).toString(),
    { timeZone: usableZone(timeZone), timeZoneName },
  )
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value ?? "";

/**
 * A time zone in the reader's words, with how far it is from UTC now:
 * "Arabian Standard Time (GMT+3)".
 */
export function zoneLabel(lang: string, timeZone: TimeZone, at = new Date()) {
  const name = part(lang, timeZone, "long", at);
  const offset = part(lang, timeZone, "shortOffset", at);
  return name && offset && name !== offset
    ? `${name} (${offset})`
    : name || offset;
}

const clocks = new Map<string, Intl.DateTimeFormat>();

/** What a clock in this zone shows at this moment, counted as if it were UTC. */
function wallTime(moment: number, timeZone: TimeZone) {
  const zone = usableZone(timeZone);
  let clock = clocks.get(zone ?? "");
  if (!clock) {
    clock = new Intl.DateTimeFormat("en-u-ca-gregory-nu-latn", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    clocks.set(zone ?? "", clock);
  }
  const p: Record<string, number> = {};
  for (const { type, value } of clock.formatToParts(moment)) {
    if (type !== "literal") p[type] = Number(value);
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

const two = (n: number) => String(n).padStart(2, "0");

/**
 * A moment as a `datetime-local` field writes it, `2026-11-25T14:05`, on the
 * clock of this zone.
 */
export function wallClock(moment: Date, timeZone: TimeZone): string {
  const d = new Date(wallTime(moment.getTime(), timeZone));
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}T${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

const DAY = 86_400_000;

/**
 * The moment at which a clock in this zone shows what a `datetime-local`
 * field holds. Null for text that is not a date and time.
 *
 * On the night the clock is put back, an hour is shown twice: the later of
 * the two moments is meant if it has already come, otherwise the earlier
 * (what is typed is never in the future when it need not be). A time the
 * clock skips when it is put forward gives the moment that much later.
 */
export function momentOf(
  wall: string,
  timeZone: TimeZone,
  now = new Date(),
): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const asUtc = new Date(0);
  // `setUTCFullYear` and not `Date.UTC`, which reads years 0 to 99 as 19xx.
  asUtc.setUTCFullYear(year, month - 1, day);
  asUtc.setUTCHours(hour, minute, 0, 0);
  const target = asUtc.getTime();
  if (Number.isNaN(target)) return null;

  const offsetAt = (moment: number) => wallTime(moment, timeZone) - moment;
  const shows = (moment: number) => wallTime(moment, timeZone) === target;
  // The clock's offset a day before and a day after: the same, unless the
  // clock changes in between.
  const earlier = target - offsetAt(target - DAY);
  const later = target - offsetAt(target + DAY);
  if (shows(later) && later <= now.getTime()) return new Date(later);
  if (shows(earlier)) return new Date(earlier);
  if (shows(later)) return new Date(later);
  return new Date(earlier);
}

/**
 * The time zones a hospital can be given: every name this browser knows,
 * and UTC, which browsers leave out of their list.
 */
export function timeZoneNames(): string[] {
  let names: string[] = [];
  try {
    names = Intl.supportedValuesOf("timeZone");
  } catch {
    // An old browser: UTC alone can still be chosen.
  }
  return ["UTC", ...names.filter((name) => name !== "UTC")];
}
