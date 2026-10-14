/**
 * A dev server command Cadence will run for a canvas: one line of words,
 * flags, and quotes, with no shell operators (; | & $ backticks or redirects).
 * `{port}` is replaced with the port Cadence picks.
 */
export const APP_COMMAND = /^[\w@./:= {}"'-]{1,200}$/;
