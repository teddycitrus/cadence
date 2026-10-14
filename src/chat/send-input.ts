import { ValidationError } from "../core/errors";
import type { Attachment } from "../core/types";
import type { Mention } from "./mentions";

export interface SendInput {
  text: string;
  attachments?: Attachment[];
  mentions?: Mention[];
}

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** A message needs text or an attachment, and no attachment over 5 MB. */
export function validateSend(input: SendInput): void {
  if (!input.text.trim() && !input.attachments?.length) throw new ValidationError("Write a message or attach something");
  for (const a of input.attachments ?? []) {
    const size = (a.data?.length ?? 0) * 0.75 + (a.text?.length ?? 0);
    if (size > MAX_ATTACHMENT_BYTES) throw new ValidationError(`${a.name} is larger than 5 MB`);
  }
}
