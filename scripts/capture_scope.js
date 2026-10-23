function localDate(now, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function validateCaptureDate(value, timezone, now = new Date()) {
  if (!value) return '';
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('ADP_CAPTURE_DATE must be a valid YYYY-MM-DD date');
  }
  if (value !== localDate(now, timezone)) {
    throw new Error(`Daily capture date ${value} is no longer today in ${timezone}`);
  }
  return value;
}

function captureDayColumn(dateRange, captureDate) {
  if (!captureDate) return '';
  const match = String(dateRange).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) throw new Error('Cannot identify the displayed schedule week');
  const start = Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2]));
  const end = Date.UTC(Number(match[6]), Number(match[4]) - 1, Number(match[5]));
  const target = Date.parse(`${captureDate}T00:00:00Z`);
  const offset = (target - start) / 86400000;
  if (end - start !== 6 * 86400000 || !Number.isInteger(offset) || offset < 0 || offset > 6) {
    throw new Error(`Capture date ${captureDate} is outside displayed schedule ${dateRange}`);
  }
  return `day-${offset}`;
}

module.exports = { localDate, validateCaptureDate, captureDayColumn };
