"use strict";

/**
 * The most recent key date (Stichtag) that is not in the future: the last day of the month (or day 1 to 28) at
 * the given time, in local time.
 *
 * @param {Date} now
 * @param {string|number} day "last" or 1 to 28
 * @param {string} time "HH:MM"
 * @returns {Date}
 */
function lastDue(now, day, time) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(time));
    const hh = m ? Math.min(23, Number(m[1])) : 23;
    const mm = m ? Math.min(59, Number(m[2])) : 59;
    for (let back = 0; back < 3; back++) {
        const y = now.getFullYear();
        const mo = now.getMonth() - back;
        const d =
            String(day) === "last"
                ? new Date(y, mo + 1, 0, hh, mm, 0, 0)
                : new Date(
                      y,
                      mo,
                      Math.max(1, Math.min(28, Number(day) || 1)),
                      hh,
                      mm,
                      0,
                      0,
                  );
        if (d.getTime() <= now.getTime()) {
            return d;
        }
    }
    return new Date(now.getFullYear(), now.getMonth() - 3 + 1, 0, hh, mm, 0, 0);
}

module.exports = { lastDue };
