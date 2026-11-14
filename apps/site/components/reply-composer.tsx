"use client";

import { useRouter } from "next/navigation";
import {
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import styles from "../app/admin/inbox/reply-composer.module.css";
import {
  MAX_REPLY_ATTACHMENTS,
  replyAttachmentAccept,
  replyAttachmentError,
} from "../src/reply-attachments";

type Feedback = { kind: "success" | "error"; message: string } | null;
type FormatState = { bold: boolean; italic: boolean; unorderedList: boolean; orderedList: boolean };

const emptyFormats: FormatState = { bold: false, italic: false, unorderedList: false, orderedList: false };

function nodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (!(node instanceof HTMLElement)) return "";
  if (node.tagName === "BR") return "\n";

  if (node.tagName === "UL" || node.tagName === "OL") {
    const ordered = node.tagName === "OL";
    return `${Array.from(node.children)
      .filter((child) => child.tagName === "LI")
      .map((item, index) => `${ordered ? `${index + 1}.` : "•"} ${nodeText(item).trim()}`)
      .join("\n")}\n`;
  }

  const content = Array.from(node.childNodes).map(nodeText).join("");
  if (node.tagName === "A") {
    const href = node.getAttribute("href");
    return href && href !== content ? `${content} (${href})` : content;
  }
  if (node.tagName === "P" || node.tagName === "DIV" || node.tagName === "LI") return `${content}\n`;
  return content;
}

function toPlainText(editor: HTMLElement) {
  return Array.from(editor.childNodes)
    .map(nodeText)
    .join("")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function ReplyComposer({ inboundEmailId, recipient }: Readonly<{ inboundEmailId: string; recipient: string }>) {
  const router = useRouter();
  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectionRef = useRef<Range | null>(null);
  const [formats, setFormats] = useState<FormatState>(emptyFormats);
  const [hasContent, setHasContent] = useState(false);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState("");

  function syncFormats() {
    try {
      setFormats({
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
        unorderedList: document.queryCommandState("insertUnorderedList"),
        orderedList: document.queryCommandState("insertOrderedList"),
      });
    } catch {
      setFormats(emptyFormats);
    }
  }

  function rememberSelection() {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) {
      selectionRef.current = range.cloneRange();
      syncFormats();
    }
  }

  function restoreSelection() {
    const editor = editorRef.current;
    if (!editor) return false;
    editor.focus({ preventScroll: true });
    const range = selectionRef.current;
    if (!range || !editor.contains(range.commonAncestorContainer)) return false;
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  }

  function updateContent() {
    const editor = editorRef.current;
    setHasContent(Boolean(editor && toPlainText(editor)));
    setFeedback(null);
  }

  function runCommand(command: "bold" | "italic" | "insertUnorderedList" | "insertOrderedList") {
    if (!restoreSelection()) editorRef.current?.focus();
    document.execCommand(command);
    rememberSelection();
    updateContent();
  }

  function keepEditorSelection(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    rememberSelection();
  }

  function openLinkEditor() {
    rememberSelection();
    if (!selectionRef.current || selectionRef.current.collapsed) {
      setFeedback({ kind: "error", message: "Select the text you want to turn into a link first." });
      return;
    }
    setLinkError("");
    setLinkOpen(true);
  }

  function applyLink() {
    const value = linkUrl.trim();
    try {
      const url = new URL(value);
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
        setLinkError("Use an http, https, or mailto link.");
        return;
      }
      if (!restoreSelection() || selectionRef.current?.collapsed) {
        setLinkError("Select the text you want to link first.");
        return;
      }
      document.execCommand("createLink", false, url.toString());
      setLinkOpen(false);
      setLinkUrl("");
      setLinkError("");
      rememberSelection();
      updateContent();
    } catch {
      setLinkError("Enter a complete link, such as https://example.com.");
    }
  }

  function linkKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      applyLink();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setLinkOpen(false);
      setLinkError("");
      restoreSelection();
    }
  }

  function pastePlainText(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
    updateContent();
  }

  function selectAttachments(event: ChangeEvent<HTMLInputElement>) {
    const selected = [...attachments];
    for (const file of Array.from(event.target.files ?? [])) {
      if (!selected.some((existing) => existing.name === file.name && existing.size === file.size && existing.lastModified === file.lastModified)) {
        selected.push(file);
      }
    }
    event.target.value = "";
    const error = replyAttachmentError(selected);
    if (error) {
      setFeedback({ kind: "error", message: error });
      return;
    }
    setAttachments(selected);
    setFeedback(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const editor = editorRef.current;
    if (!editor || sending) return;
    const text = toPlainText(editor);
    if (!text) {
      setFeedback({ kind: "error", message: "Write a reply before sending." });
      editor.focus();
      return;
    }

    const attachmentError = replyAttachmentError(attachments);
    if (attachmentError) {
      setFeedback({ kind: "error", message: attachmentError });
      return;
    }

    setSending(true);
    setFeedback(null);
    setLinkOpen(false);
    try {
      const body = new FormData();
      body.set("inboundEmailId", inboundEmailId);
      body.set("html", editor.innerHTML);
      body.set("text", text);
      for (const attachment of attachments) body.append("attachments", attachment, attachment.name);

      const response = await fetch("/api/admin/replies", { method: "POST", body });
      const result = await response.json().catch(() => null) as { error?: string; message?: string } | null;
      if (!response.ok || result?.error) {
        throw new Error(result?.message || result?.error || "We could not send your reply. Please try again.");
      }

      editor.replaceChildren();
      selectionRef.current = null;
      setHasContent(false);
      setFormats(emptyFormats);
      setAttachments([]);
      setFeedback({ kind: "success", message: "Reply sent. The conversation has been updated." });
      router.refresh();
    } catch (error) {
      setFeedback({
        kind: "error",
        message: error instanceof Error ? error.message : "We could not send your reply. Please try again.",
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <section className={styles.composer} aria-labelledby="reply-title">
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Continue the conversation</p>
          <h2 id="reply-title">Write a reply</h2>
        </div>
        <p className={styles.recipient}>To <span>{recipient || "Unknown sender"}</span></p>
      </div>

      <form className={styles.form} onSubmit={submit} aria-busy={sending}>
        <div className={styles.toolbar} role="toolbar" aria-label="Reply formatting">
          <button
            className={styles.toolButton}
            type="button"
            aria-label="Bold"
            aria-pressed={formats.bold}
            title="Bold"
            disabled={sending}
            onMouseDown={keepEditorSelection}
            onClick={() => runCommand("bold")}
          >
            <strong aria-hidden="true">B</strong>
          </button>
          <button
            className={styles.toolButton}
            type="button"
            aria-label="Italic"
            aria-pressed={formats.italic}
            title="Italic"
            disabled={sending}
            onMouseDown={keepEditorSelection}
            onClick={() => runCommand("italic")}
          >
            <em aria-hidden="true">I</em>
          </button>
          <span className={styles.divider} aria-hidden="true" />
          <button
            className={styles.toolButton}
            type="button"
            aria-label="Bulleted list"
            aria-pressed={formats.unorderedList}
            title="Bulleted list"
            disabled={sending}
            onMouseDown={keepEditorSelection}
            onClick={() => runCommand("insertUnorderedList")}
          >
            <span aria-hidden="true">•≡</span>
          </button>
          <button
            className={styles.toolButton}
            type="button"
            aria-label="Numbered list"
            aria-pressed={formats.orderedList}
            title="Numbered list"
            disabled={sending}
            onMouseDown={keepEditorSelection}
            onClick={() => runCommand("insertOrderedList")}
          >
            <span aria-hidden="true">1≡</span>
          </button>
          <span className={styles.divider} aria-hidden="true" />
          <button
            className={styles.toolButton}
            type="button"
            aria-label="Add link"
            title="Add link to selected text"
            disabled={sending}
            onMouseDown={keepEditorSelection}
            onClick={openLinkEditor}
          >
            <span aria-hidden="true">↗</span>
          </button>
        </div>

        {linkOpen ? (
          <div className={styles.linkEditor}>
            <label className={styles.linkLabel}>
              Link URL
              <input
                className={styles.linkInput}
                type="url"
                value={linkUrl}
                placeholder="https://example.com"
                autoFocus
                disabled={sending}
                onChange={(event) => setLinkUrl(event.target.value)}
                onKeyDown={linkKeyDown}
                aria-describedby={linkError ? "reply-link-error" : undefined}
              />
            </label>
            <div className={styles.linkActions}>
              <button className={styles.smallButton} type="button" onClick={applyLink} disabled={sending}>Apply link</button>
              <button
                className={styles.cancelButton}
                type="button"
                disabled={sending}
                onClick={() => {
                  setLinkOpen(false);
                  setLinkError("");
                  restoreSelection();
                }}
              >
                Cancel
              </button>
            </div>
            {linkError ? <p className={styles.linkError} id="reply-link-error" role="alert">{linkError}</p> : null}
          </div>
        ) : null}

        <div
          ref={editorRef}
          className={styles.editor}
          contentEditable={!sending}
          role="textbox"
          aria-label="Reply message"
          aria-multiline="true"
          aria-disabled={sending}
          aria-describedby="reply-hint"
          data-placeholder="Write something thoughtful…"
          suppressContentEditableWarning
          onInput={updateContent}
          onKeyUp={rememberSelection}
          onMouseUp={rememberSelection}
          onFocus={rememberSelection}
          onPaste={pastePlainText}
        />

        <div className={styles.attachmentArea}>
          <div className={styles.attachmentControls}>
            <input
              ref={fileInputRef}
              className={styles.fileInput}
              type="file"
              multiple
              accept={replyAttachmentAccept}
              tabIndex={-1}
              disabled={sending}
              onChange={selectAttachments}
            />
            <button
              className={styles.attachButton}
              type="button"
              disabled={sending}
              onClick={() => fileInputRef.current?.click()}
            >
              Attach files
            </button>
            <p className={styles.attachmentHint}>
              Up to {MAX_REPLY_ATTACHMENTS} files, 4 MB total. PDF, Office documents, images, CSV, or TXT.
            </p>
          </div>
          {attachments.length > 0 ? (
            <ul className={styles.attachmentList} aria-label="Reply attachments">
              {attachments.map((attachment, index) => (
                <li className={styles.attachmentItem} key={`${attachment.name}:${attachment.size}:${attachment.lastModified}`}>
                  <span className={styles.attachmentName}>
                    {attachment.name}
                    <span className={styles.attachmentSize}>{formatFileSize(attachment.size)}</span>
                  </span>
                  <button
                    className={styles.removeAttachment}
                    type="button"
                    disabled={sending}
                    aria-label={`Remove ${attachment.name}`}
                    onClick={() => {
                      setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index));
                      setFeedback(null);
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className={styles.footer}>
          <p className={styles.hint} id="reply-hint">Formatting is preserved in the email. Links should include https://</p>
          <button className={styles.sendButton} type="submit" disabled={sending || !hasContent}>
            {sending ? "Sending…" : "Send reply"}
            {!sending ? <span aria-hidden="true">→</span> : null}
          </button>
        </div>
        <div className={styles.feedbackRegion} aria-live="polite" aria-atomic="true">
          {feedback ? (
            <p className={`${styles.feedback} ${feedback.kind === "success" ? styles.success : styles.error}`} role={feedback.kind === "error" ? "alert" : "status"}>
              {feedback.message}
            </p>
          ) : null}
        </div>
      </form>
    </section>
  );
}
