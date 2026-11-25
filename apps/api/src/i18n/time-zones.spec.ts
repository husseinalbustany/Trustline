import {
  addDays,
  dayOf,
  isTimeZone,
  lastDays,
  shiftDay,
  startOfDay,
} from './time-zones.js';

const at = (iso: string) => new Date(iso);

describe("a hospital's own calendar", () => {
  describe('the name of a time zone', () => {
    it('is UTC or an IANA name the runtime knows', () => {
      for (const name of [
        'UTC',
        'Asia/Beirut',
        'Asia/Riyadh',
        'Africa/Casablanca',
        'America/Argentina/Buenos_Aires',
        'Pacific/Kiritimati',
      ]) {
        expect([name, isTimeZone(name)]).toEqual([name, true]);
      }
    });

    it('is not an offset, an abbreviation, or anything else', () => {
      for (const name of [
        '',
        'utc',
        '+03:00',
        'UTC+3',
        'GMT+3',
        'EST',
        'Mars/Olympus',
        'Asia/Beirut; drop table tenants',
        ' Asia/Beirut',
        'Asia/',
        null,
        undefined,
        3,
        ['Asia/Beirut'],
      ]) {
        expect([name, isTimeZone(name)]).toEqual([name, false]);
      }
    });
  });

  describe('the day it is', () => {
    it('is the day on the clock there, not in UTC', () => {
      // Half past midnight in Riyadh (three hours ahead) is still the
      // evening before in UTC.
      const moment = at('2026-03-09T21:30:00Z');
      expect(dayOf(moment, 'UTC')).toBe('2026-03-09');
      expect(dayOf(moment, 'Asia/Riyadh')).toBe('2026-03-10');
      // And late evening in New York is already the next day in UTC.
      const evening = at('2026-03-10T03:30:00Z');
      expect(dayOf(evening, 'UTC')).toBe('2026-03-10');
      expect(dayOf(evening, 'America/New_York')).toBe('2026-03-09');
    });

    it('turns over at the very moment of midnight there', () => {
      expect(dayOf(at('2026-03-09T20:59:59.999Z'), 'Asia/Riyadh')).toBe(
        '2026-03-09',
      );
      expect(dayOf(at('2026-03-09T21:00:00.000Z'), 'Asia/Riyadh')).toBe(
        '2026-03-10',
      );
    });

    it('works at the far ends of the map and across a year', () => {
      const moment = at('2026-12-31T10:30:00Z');
      expect(dayOf(moment, 'Pacific/Kiritimati')).toBe('2027-01-01');
      expect(dayOf(moment, 'Pacific/Pago_Pago')).toBe('2026-12-30');
    });
  });

  describe('the first moment of a day', () => {
    it('is midnight on the clock there', () => {
      expect(startOfDay('2026-03-10', 'UTC')).toEqual(
        at('2026-03-10T00:00:00Z'),
      );
      expect(startOfDay('2026-03-10', 'Asia/Riyadh')).toEqual(
        at('2026-03-09T21:00:00Z'),
      );
      expect(startOfDay('2026-01-15', 'America/New_York')).toEqual(
        at('2026-01-15T05:00:00Z'),
      );
      // In summer time, an hour earlier than in winter.
      expect(startOfDay('2026-07-15', 'America/New_York')).toEqual(
        at('2026-07-15T04:00:00Z'),
      );
    });

    it('is the moment the clock jumps, where it is put forward at midnight', () => {
      // Lebanon puts its clocks forward at midnight: on 29 March 2026 the
      // clock goes from 23:59 on the 28th to 01:00 on the 29th.
      const start = startOfDay('2026-03-29', 'Asia/Beirut');
      expect(start).toEqual(at('2026-03-28T22:00:00Z'));
      expect(dayOf(start, 'Asia/Beirut')).toBe('2026-03-29');
      expect(dayOf(new Date(start.getTime() - 1), 'Asia/Beirut')).toBe(
        '2026-03-28',
      );
      // That day is 23 hours long.
      const next = startOfDay('2026-03-30', 'Asia/Beirut');
      expect(next.getTime() - start.getTime()).toBe(23 * 3_600_000);
    });

    it('is the first midnight, where the clock is put back over it', () => {
      // Cuba puts its clocks back from 01:00 to 00:00: the first hour of
      // 1 November 2026 happens twice.
      const start = startOfDay('2026-11-01', 'America/Havana');
      expect(start).toEqual(at('2026-11-01T04:00:00Z'));
      expect(dayOf(new Date(start.getTime() - 1), 'America/Havana')).toBe(
        '2026-10-31',
      );
    });

    it('agrees with the day it is, for every hour of a year, in many places', () => {
      for (const zone of [
        'UTC',
        'Asia/Beirut',
        'Asia/Riyadh',
        'Asia/Kolkata',
        'Europe/Paris',
        'America/Havana',
        'America/St_Johns',
        'Australia/Lord_Howe',
        'Pacific/Kiritimati',
      ]) {
        const from = Date.UTC(2026, 0, 1);
        for (let hour = 0; hour < 366 * 24; hour += 1) {
          const moment = new Date(from + hour * 3_600_000 + 1_234);
          const day = dayOf(moment, zone);
          const start = startOfDay(day, zone).getTime();
          const end = startOfDay(shiftDay(day, 1), zone).getTime();
          // Every moment lies in the day it is said to be on.
          if (!(start <= moment.getTime() && moment.getTime() < end)) {
            throw new Error(`${zone} ${moment.toISOString()} is not in ${day}`);
          }
        }
      }
    });
  });

  describe('counting in days', () => {
    it('moves a day forward and back, across months and leap years', () => {
      expect(shiftDay('2026-03-10', 1)).toBe('2026-03-11');
      expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
      expect(shiftDay('2028-02-28', 1)).toBe('2028-02-29');
      expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
      expect(shiftDay('2026-03-10', -29)).toBe('2026-02-09');
    });

    it('keeps the time of day when the clock changes in between', () => {
      // 10:15 in Beirut on 20 March, winter time; 30 days later it is summer
      // time, and the deadline is still at 10:15 there: 719 hours on.
      const reported = at('2026-03-20T08:15:00Z');
      const due = addDays(reported, 30, 'Asia/Beirut');
      expect(due).toEqual(at('2026-04-19T07:15:00Z'));
      expect(due.getTime() - reported.getTime()).toBe(719 * 3_600_000);
      // Where the clock never changes it is 30 times 24 hours.
      expect(addDays(reported, 30, 'Asia/Riyadh')).toEqual(
        at('2026-04-19T08:15:00Z'),
      );
      expect(addDays(reported, 30, 'UTC')).toEqual(at('2026-04-19T08:15:00Z'));
    });

    it('keeps the milliseconds, and lands after a time the clock skips', () => {
      const moment = at('2026-03-20T08:15:30.250Z');
      expect(addDays(moment, 1, 'UTC')).toEqual(at('2026-03-21T08:15:30.250Z'));
      // 00:30 does not exist in Beirut on 29 March 2026: 01:30 it is.
      const late = at('2026-03-27T22:30:00Z'); // 00:30 on the 28th there
      expect(addDays(late, 1, 'Asia/Beirut')).toEqual(
        at('2026-03-28T22:30:00Z'),
      );
    });
  });

  describe('the last 30 days', () => {
    it("are today on the hospital's calendar and the 29 days before it", () => {
      // 00:30 on 10 March in Riyadh; still the 9th in UTC.
      const now = at('2026-03-09T21:30:00Z');
      expect(lastDays(30, 'Asia/Riyadh', now)).toEqual({
        from: '2026-02-09',
        to: '2026-03-10',
        since: at('2026-02-08T21:00:00Z'),
      });
      expect(lastDays(30, 'UTC', now)).toEqual({
        from: '2026-02-08',
        to: '2026-03-09',
        since: at('2026-02-08T00:00:00Z'),
      });
    });

    it('move on at midnight there, not at midnight UTC', () => {
      const before = lastDays(30, 'Asia/Riyadh', at('2026-03-09T20:59:59Z'));
      const after = lastDays(30, 'Asia/Riyadh', at('2026-03-09T21:00:00Z'));
      expect(before.to).toBe('2026-03-09');
      expect(after.to).toBe('2026-03-10');
      expect(after.since.getTime() - before.since.getTime()).toBe(86_400_000);
    });
  });
});
