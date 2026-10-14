export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class ValidationError extends Error {}
/** The person is signed in but not allowed to do this. */
export class ForbiddenError extends Error {}

/** Raised when an agent tries to move a card past a sign-off stage. */
export class GateError extends Error {}
