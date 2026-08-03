function partsRecord(formatter, date) {
  return Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
}

export function getDateTime(timezone = "", value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw Object.assign(new Error("Invalid date."), { code: "INVALID_ARGUMENT" });
  const zone = String(timezone || Intl.DateTimeFormat().resolvedOptions().timeZone).trim();
  try {
    const numeric = partsRecord(new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23"
    }), date);
    const zoneParts = partsRecord(new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "longOffset"
    }), date);
    return {
      timezone: zone,
      localDate: `${numeric.year}-${numeric.month}-${numeric.day}`,
      localTime: `${numeric.hour}:${numeric.minute}:${numeric.second}`,
      utcOffset: zoneParts.timeZoneName || "",
      local: new Intl.DateTimeFormat("en-US", {
        dateStyle: "full", timeStyle: "long", timeZone: zone
      }).format(date),
      utcIso: date.toISOString(),
      epochMilliseconds: date.getTime()
    };
  } catch {
    throw Object.assign(new Error("Invalid IANA timezone."), { code: "INVALID_ARGUMENT" });
  }
}

export function currentClockContext(timezone = "", value = new Date()) {
  const clock = getDateTime(timezone, value);
  return `Authoritative current clock from this Evolv installation:\n- Local date: ${clock.localDate}\n- Local time: ${clock.localTime} (${clock.utcOffset})\n- IANA timezone: ${clock.timezone}\n- Full local value: ${clock.local}\n- UTC instant (reference only, do not report as local time): ${clock.utcIso}\nUse the local value for today, now, tonight, tomorrow, yesterday, and this year. Do not substitute a date from training data. Use get_datetime only when the user asks for another timezone.`;
}
