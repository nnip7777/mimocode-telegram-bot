export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\[[\?]?[0-9;]*[a-zA-Z]/g, "")
    .replace(/[─-╿]/g, "")
    .replace(/[▀-▟]/g, "")
    .replace(/[■-◿]/g, "");
}

export function stripSystemTags(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

export function markdownToTelegramHtml(text: string): string {
  if (!text) return "";

  const codeBlocks: string[] = [];
  text = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code: string) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_, code: string) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  text = text.replace(/^#{1,6}\s+(.+)$/gm, "\x00B\x00$1\x00/B\x00");
  text = text.replace(/^>\s*(.*)$/gm, "$1");
  text = escapeHtml(text);

  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  text = text.replace(/__(.+?)__/g, "<b>$1</b>");
  text = text.replace(
    /(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g,
    "<i>$1</i>",
  );
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");
  text = text.replace(/^[-*]\s+\[x\]\s+/gm, "✅ ");
  text = text.replace(/^[-*]\s+\[ \]\s+/gm, "⬜ ");
  text = text.replace(/^[-*_]{3,}\s*$/gm, "―");
  text = text.replace(/^[-*]\s+/gm, "• ");
  text = text.replace(/^(\d+)\.\s+/gm, "$1. ");

  // Handle unclosed code fence
  const unclosedFence = text.indexOf("```");
  if (unclosedFence !== -1) {
    const before = text.slice(0, unclosedFence);
    const codeContent = text.slice(unclosedFence + 3).replace(/\n$/, "");
    text = before + `<pre><code>${escapeHtml(codeContent)}</code></pre>`;
  }

  for (let i = 0; i < inlineCodes.length; i++) {
    text = text.replace(
      `\x00IC${i}\x00`,
      `<code>${escapeHtml(inlineCodes[i] ?? "")}</code>`,
    );
  }

  for (let i = 0; i < codeBlocks.length; i++) {
    text = text.replace(
      `\x00CB${i}\x00`,
      `<pre><code>${escapeHtml(codeBlocks[i] ?? "")}</code></pre>`,
    );
  }

  text = text.replace(/\x00B\x00/g, "<b>").replace(/\x00\/B\x00/g, "</b>");

  return text;
}

export function wrapCode(text: string): string {
  return `<pre><code>${escapeHtml(stripAnsi(text))}</code></pre>`;
}

export function formatLong(text: string): string[] {
  const BUDGET = 3500;

  if (text.length <= BUDGET) {
    return [markdownToTelegramHtml(text)];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= BUDGET) {
      chunks.push(markdownToTelegramHtml(remaining));
      break;
    }

    let cutAt = remaining.lastIndexOf("\n", BUDGET);
    if (cutAt <= 0) {
      cutAt = remaining.lastIndexOf(" ", BUDGET);
    }
    if (cutAt <= 0) {
      cutAt = BUDGET;
    }

    chunks.push(markdownToTelegramHtml(remaining.slice(0, cutAt)));
    remaining = remaining.slice(cutAt + 1);
  }

  return chunks;
}

export function parseJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
