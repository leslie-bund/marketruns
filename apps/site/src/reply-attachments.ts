export const MAX_REPLY_ATTACHMENTS = 5;
export const MAX_REPLY_ATTACHMENT_BYTES = 4 * 1024 * 1024;

const allowedAttachments: Record<string, string[]> = {
  "application/pdf": ["pdf"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "text/plain": ["txt"],
  "text/csv": ["csv"],
  "application/msword": ["doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.ms-excel": ["xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
};

export const replyAttachmentAccept = Object.values(allowedAttachments).flat().map((extension) => `.${extension}`).join(",");

export interface ReplyAttachmentMetadata {
  name: string;
  size: number;
  type: string;
}

export interface ReplyAttachment extends ReplyAttachmentMetadata {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export function isReplyAttachment(value: unknown): value is ReplyAttachment {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ReplyAttachment>;
  return typeof candidate.name === "string"
    && typeof candidate.size === "number"
    && typeof candidate.type === "string"
    && typeof candidate.arrayBuffer === "function";
}

export function replyAttachmentError(attachments: ReplyAttachmentMetadata[]): string | null {
  if (attachments.length > MAX_REPLY_ATTACHMENTS) return `Attach no more than ${MAX_REPLY_ATTACHMENTS} files.`;

  let totalBytes = 0;
  for (const attachment of attachments) {
    const filename = attachment.name.trim();
    if (!filename || filename !== attachment.name || filename.length > 128 || /[\/\\\x00-\x1f]/.test(filename)) {
      return "Attachment filenames must be plain names of 128 characters or fewer.";
    }
    if (!Number.isSafeInteger(attachment.size) || attachment.size <= 0) {
      return `${filename} is empty or has an invalid size.`;
    }
    totalBytes += attachment.size;
    if (totalBytes > MAX_REPLY_ATTACHMENT_BYTES) return "Attachments must be 4 MB or smaller in total.";

    const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
    if (!allowedAttachments[attachment.type.toLowerCase()]?.includes(extension)) {
      return `${filename} is not a supported PDF, Office document, image, CSV, or TXT file.`;
    }
  }
  return null;
}
