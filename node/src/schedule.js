/**
 * Monitor schedules.
 *
 * Firecrawl takes a cron expression or a phrase like "every 30 minutes" and
 * runs the check on that clock. This service needs the same two forms, but not
 * the whole of cron: a monitor is a local file and a timer, so the schedule is
 * resolved to a next-run instant in UTC and nothing else.
 *
 * Weekdays, ranges and steps are supported because they are the forms people
 * actually write and because a five-field expression that silently means
 * something else is worse than a refusal. Anything outside that is refused with
 * the phrase Firecrawl documents, so a caller can fix it.
 *
 * UTC only: a monitor that runs "daily at 9:00" would otherwise mean a
 * different instant for every deployment, and the store here has no timezone
 * database of its own. Naming another zone is refused rather than quietly
 * reinterpreted.
 */

/** Firecrawl's floor. A faster check costs a fetch every time and is not a monitor. */
const MIN_INTERVAL_MS = 5 * 60 * 1000;

/** A year is the longest gap a sane expression can have. */
const SEARCH_MINUTES = 366 * 24 * 60;

const WEEKDAYS = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'E_BAD_SCHEDULE' });
}

function parseMinuteStart(value) {
  if (value === undefined) return 0;
  const minute = Number(value);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw invalid('Schedule start minute must be between 0 and 59');
  }
  return minute;
}

function divides(value, divisor, unit) {
  if (divisor % value !== 0) throw invalid(`${unit} interval must divide evenly into ${divisor}`);
}

/**
 * The phrase form. The vocabulary is Firecrawl's, because the skill writes the
 * phrase and the CLI forwards it; accepting a different set would make the
 * documented examples fail.
 */
export function parseScheduleText(input) {
  const text = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ');

  const everyMinutes = text.match(/^every (\d+) (?:minutes?|mins?)(?: (?:starting|start)(?: at| on)? :?(\d{1,2}))?$/);
  if (everyMinutes) {
    const interval = Number(everyMinutes[1]);
    if (!Number.isInteger(interval) || interval <= 0 || interval > 60) {
      throw invalid('Minute interval must be between 1 and 60');
    }
    divides(interval, 60, 'Minute');
    const start = parseMinuteStart(everyMinutes[2]);
    return start === 0 ? `*/${interval} * * * *` : `${start}-59/${interval} * * * *`;
  }

  const hourly = text.match(/^(?:hourly|every hour)(?: (?:at|starting at) :?(\d{1,2}))?$/);
  if (hourly) return `${parseMinuteStart(hourly[1])} * * * *`;

  const everyHours = text.match(/^every (\d+) (?:hours?|hrs?)$/);
  if (everyHours) {
    const interval = Number(everyHours[1]);
    if (!Number.isInteger(interval) || interval <= 0 || interval > 24) {
      throw invalid('Hour interval must be between 1 and 24');
    }
    divides(interval, 24, 'Hour');
    return `0 */${interval} * * *`;
  }

  const daily = text.match(/^(?:daily|every day)(?: at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/);
  if (daily) {
    let hour = daily[1] === undefined ? 0 : Number(daily[1]);
    const minute = daily[2] === undefined ? 0 : Number(daily[2]);
    const meridiem = daily[3];
    if (meridiem !== undefined) {
      if (!Number.isInteger(hour) || hour < 1 || hour > 12) {
        throw invalid('Daily schedule hour with am/pm must be between 1 and 12');
      }
      if (meridiem === 'am') hour = hour === 12 ? 0 : hour;
      else hour = hour === 12 ? 12 : hour + 12;
    }
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw invalid('Daily schedule hour must be between 0 and 23');
    }
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw invalid('Daily schedule minute must be between 0 and 59');
    }
    return `${minute} ${hour} * * *`;
  }

  const weekly = text.match(/^(?:weekly|every week)(?: on (\w+))?$/);
  if (weekly && (!weekly[1] || WEEKDAYS[weekly[1]] !== undefined)) {
    return `0 0 * * ${weekly[1] ? WEEKDAYS[weekly[1]] : 0}`;
  }

  throw invalid("Unsupported schedule text. Try phrases like 'every 30 minutes', 'hourly', or 'daily at 9:00'");
}

function parseField(field, min, max) {
  const values = new Set();
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0) throw invalid(`Invalid cron step '${stepText}'`);

    let start;
    let end;
    if (range === '*') {
      start = min;
      end = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      start = a;
      end = b;
    } else {
      start = Number(range);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw invalid(`Cron field '${field}' is outside ${min}-${max}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

/** Five fields, numbers only. Names such as `MON` are refused rather than guessed. */
export function parseCron(expression) {
  const parts = String(expression ?? '').trim().split(/\s+/);
  if (parts.length !== 5) throw invalid('Cron expression must contain five fields');
  const daysOfWeek = parseField(parts[4], 0, 7);
  // Both 0 and 7 mean Sunday. Keeping both would just mean testing twice.
  if (daysOfWeek.has(7)) {
    daysOfWeek.add(0);
    daysOfWeek.delete(7);
  }
  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    daysOfMonth: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    daysOfWeek,
  };
}

function matches(date, cron) {
  return cron.minutes.has(date.getUTCMinutes())
    && cron.hours.has(date.getUTCHours())
    && cron.daysOfMonth.has(date.getUTCDate())
    && cron.months.has(date.getUTCMonth() + 1)
    && cron.daysOfWeek.has(date.getUTCDay());
}

/**
 * First instant strictly after `from` that the expression names, at minute
 * precision.
 *
 * Stepping a minute at a time is the obvious reading of cron and is fast enough
 * for the rare yearly expression: the loop is arithmetic, and the answer is
 * computed once when the monitor is created or a check finishes.
 */
export function nextRunAt(expression, from = new Date()) {
  const cron = parseCron(expression);
  const candidate = new Date(from);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let step = 0; step < SEARCH_MINUTES; step += 1) {
    if (matches(candidate, cron)) return candidate;
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw invalid('Cron expression did not produce a run within one year');
}

/**
 * Validates the request's `schedule` object and returns the cron, its next run
 * and the interval between two runs. The interval is what enforces the floor.
 */
export function validateSchedule(schedule = {}) {
  const cron = schedule.cron ? String(schedule.cron) : parseScheduleText(schedule.text);
  if (schedule.cron && schedule.text) {
    throw invalid('Schedule must include either cron or text, not both');
  }
  const timezone = String(schedule.timezone ?? 'UTC');
  if (!/^(?:utc|etc\/utc|gmt|z)$/i.test(timezone)) {
    throw invalid('monitors run on UTC in this deployment; leave timezone as UTC');
  }

  const next = nextRunAt(cron);
  const after = nextRunAt(cron, next);
  const intervalMs = after.getTime() - next.getTime();
  if (intervalMs < MIN_INTERVAL_MS) {
    throw invalid('Monitor schedule must not run more often than every 5 minutes');
  }
  return { cron, timezone, nextRunAt: next, intervalMs };
}

export function estimateRunsPerMonth(intervalMs) {
  return Math.ceil((30 * 24 * 60 * 60 * 1000) / intervalMs);
}

export { MIN_INTERVAL_MS };
