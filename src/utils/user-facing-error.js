/**
 * Telling a message WRITTEN FOR A USER apart from the text of an accident.
 *
 * Finding V13-P12-F2. Several import and normalisation paths catch broadly on purpose - a
 * malformed spreadsheet must come back as a per-field validation error the firm can act on, not as
 * a 500 - and then copy `error.message` into that field. Inside a `200 OK` preview body, which is
 * where those fields live, that text never passes through the Express error handler, so
 * `publicErrorMessage` in `app.js` never gets the chance to replace it. A `TypeError` from a bug in
 * our own parser therefore arrives beside a row number and a column name, reading to a chartered
 * accountant as a statement about their return.
 *
 * The discriminator is not new. Two places already mark authored copy the same way, independently:
 * `importRequestError` in `import-preview.service.js` and `StatutoryDateError` in
 * `robust-normalize.service.js` both set `statusCode = 400`. This module names that convention and
 * makes it checkable, rather than inventing a third marker beside them.
 *
 * A 4xx says "this message is about the caller's input, and was written to be read". Anything with
 * no status, or a 5xx, is about us, and its text is not for them.
 */

/**
 * Build an error whose message is safe to show a user.
 *
 * @param {string} message Copy written for a person, not a diagnostic.
 * @param {object} [extra] Extra fields to attach, e.g. `{ code, details }`.
 */
export function userFacingError(message, extra = {}) {
  const error = new Error(message);
  error.statusCode = 400;
  return Object.assign(error, extra);
}

/**
 * True when this error's message was authored for a user.
 */
export function isUserFacingError(error) {
  const status = Number(error?.statusCode ?? error?.status);
  return Number.isInteger(status) && status >= 400 && status < 500;
}

/**
 * The message to show, or fixed fallback copy when the error was not written for a user.
 *
 * Use this at every site that copies exception text into a response the user reads. The fallback
 * should say what the person can DO, since by definition we cannot say what went wrong.
 */
export function userFacingMessage(error, fallback) {
  if (!isUserFacingError(error)) return fallback;
  const message = typeof error?.message === "string" ? error.message.trim() : "";
  return message || fallback;
}
