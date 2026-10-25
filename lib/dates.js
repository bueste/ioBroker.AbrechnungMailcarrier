"use strict";

/**
 * Local calendar date of a Date as "YYYY-MM-DD" (the billing day is a local day, not a UTC day).
 *
 * @param date
 */
function localDate(date) {
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${date.getFullYear()}-${m}-${d}`;
}

/**
 * "YYYY-MM-DD" plus n days, calendar arithmetic without any time zone influence.
 *
 * @param dateStr
 * @param n
 */
function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return t.toISOString().slice(0, 10);
}

/**
 * Valid "YYYY-MM-DD" (and a real calendar day)?
 *
 * @param value
 */
function isDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }
    return addDays(value, 0) === value;
}

/**
 * Parses "HH:MM" into { hour, minute }, or null.
 *
 * @param value
 */
function parseTime(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
    if (!m) {
        return null;
    }
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    return hour < 24 && minute < 60 ? { hour, minute } : null;
}

/**
 * Milliseconds from `now` until the next occurrence of hour:minute (today if still ahead, else tomorrow).
 *
 * @param now
 * @param hour
 * @param minute
 */
function msUntil(now, hour, minute) {
    const next = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        hour,
        minute,
        0,
        0,
    );
    if (next.getTime() <= now.getTime()) {
        next.setDate(next.getDate() + 1);
    }
    return next.getTime() - now.getTime();
}

module.exports = { localDate, addDays, isDate, parseTime, msUntil };
