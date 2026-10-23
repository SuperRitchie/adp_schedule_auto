const test = require('node:test');
const assert = require('node:assert/strict');
const { captureDayColumn, validateCaptureDate } = require('../scripts/capture_scope');

test('daily column follows the displayed week, including sunday and saturday', () => {
  assert.equal(captureDayColumn('10/18/2026 - 10/24/2026', '2026-10-18'), 'day-0');
  assert.equal(captureDayColumn('10/18/2026 - 10/24/2026', '2026-10-23'), 'day-5');
  assert.equal(captureDayColumn('10/18/2026 - 10/24/2026', '2026-10-24'), 'day-6');
  assert.equal(captureDayColumn('10/19/2026 - 10/25/2026', '2026-10-23'), 'day-4');
});

test('column arithmetic works over month, year and daylight saving boundaries', () => {
  assert.equal(captureDayColumn('10/31/2026 - 11/06/2026', '2026-11-02'), 'day-2');
  assert.equal(captureDayColumn('12/27/2026 - 1/02/2027', '2027-01-01'), 'day-5');
});

test('a stale or unexpected displayed week aborts the daily refresh', () => {
  assert.throws(() => captureDayColumn('10/18/2026 - 10/24/2026', '2026-10-25'));
  assert.throws(() => captureDayColumn('10/18/2026 - 10/20/2026', '2026-10-19'));
  assert.throws(() => captureDayColumn('loading', '2026-10-23'));
});

test('today uses vancouver rather than the utc date on the runner', () => {
  const now = new Date('2026-10-24T02:00:00Z');
  assert.equal(validateCaptureDate('2026-10-23', 'America/Vancouver', now), '2026-10-23');
  assert.throws(() => validateCaptureDate('2026-10-24', 'America/Vancouver', now));
  assert.throws(() => validateCaptureDate('2026-10-22', 'America/Vancouver', now));
});

test('invalid dates are rejected and full captures have no daily filter', () => {
  assert.throws(() => validateCaptureDate('2026-02-30', 'America/Vancouver'));
  assert.equal(validateCaptureDate('', 'America/Vancouver'), '');
  assert.equal(captureDayColumn('10/18/2026 - 10/24/2026', ''), '');
});
