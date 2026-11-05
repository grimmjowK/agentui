function withProtectedCode(text: string, transform: (segment: string) => string): string {
  if (!text || typeof text !== 'string') return text;

  const codeBlocks: string[] = [];
  const placeholderPrefix = '__CODE_SEGMENT_';
  const placeholderSuffix = '__';

  const masked = text.replace(/(`{3,})[\s\S]*?\1|(`+)([^`\r\n]+?)\2/g, (match) => {
    const index = codeBlocks.length;
    codeBlocks.push(match);
    return `${placeholderPrefix}${index}${placeholderSuffix}`;
  });

  const transformed = transform(masked);

  return transformed.replace(
    new RegExp(`${placeholderPrefix}(\\d+)${placeholderSuffix}`, 'g'),
    (_match, index) => codeBlocks[parseInt(index, 10)],
  );
}

export function decodeHtmlEntities(text: string) {
  if (!text) return text;
  return withProtectedCode(text, (segment) =>
    segment
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&'),
  );
}

export function normalizeInlineCodeFences(text: string) {
  if (!text || typeof text !== 'string') return text;
  try {
    const fencedBlocks: string[] = [];
    const placeholderPrefix = '__FENCED_CODE_BLOCK_';
    const placeholderSuffix = '__';

    // Protect multi-line fenced code blocks so closing ``` + newline + text + newline + opening ```
    // can never be matched across two adjacent code blocks.
    const masked = text.replace(
      /(^|\r?\n)([ \t]*(`{3,})[^\r\n]*\r?\n[\s\S]*?\r?\n[ \t]*\3[ \t]*)(?=\r?\n|$)/g,
      (_match, leadingNewline, block) => {
        const index = fencedBlocks.length;
        fencedBlocks.push(block);
        return `${leadingNewline}${placeholderPrefix}${index}${placeholderSuffix}`;
      },
    );

    const normalized = masked.replace(/(?<!`)```[ \t]*([^\n\r`]+?)[ \t]*```(?!`)/g, '`$1`');

    return normalized.replace(
      new RegExp(`${placeholderPrefix}(\\d+)${placeholderSuffix}`, 'g'),
      (_match, index) => fencedBlocks[parseInt(index, 10)],
    );
  } catch {
    return text;
  }
}

export function unescapeWithMathProtection(text: string) {
  if (!text || typeof text !== 'string') return text;

  return withProtectedCode(text, (segment) => {
    const mathBlocks: string[] = [];
    const placeholderPrefix = '__MATH_BLOCK_';
    const placeholderSuffix = '__';

    let processedText = segment.replace(/\$\$([\s\S]*?)\$\$|\$([^\$\n]+?)\$/g, (match) => {
      const index = mathBlocks.length;
      mathBlocks.push(match);
      return `${placeholderPrefix}${index}${placeholderSuffix}`;
    });

    processedText = processedText.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');

    processedText = processedText.replace(
      new RegExp(`${placeholderPrefix}(\\d+)${placeholderSuffix}`, 'g'),
      (_match, index) => {
        return mathBlocks[parseInt(index, 10)];
      },
    );

    return processedText;
  });
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatUsageLimitText(text: string) {
  try {
    if (typeof text !== 'string') return text;
    return text.replace(/Claude AI usage limit reached\|(\d{10,13})/g, (match, ts) => {
      let timestampMs = parseInt(ts, 10);
      if (!Number.isFinite(timestampMs)) return match;
      if (timestampMs < 1e12) timestampMs *= 1000;
      const reset = new Date(timestampMs);

      const timeStr = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(reset);

      const offsetMinutesLocal = -reset.getTimezoneOffset();
      const sign = offsetMinutesLocal >= 0 ? '+' : '-';
      const abs = Math.abs(offsetMinutesLocal);
      const offH = Math.floor(abs / 60);
      const offM = abs % 60;
      const gmt = `GMT${sign}${offH}${offM ? ':' + String(offM).padStart(2, '0') : ''}`;
      const tzId = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const cityRaw = tzId.split('/').pop() || '';
      const city = cityRaw
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (char) => char.toUpperCase());
      const tzHuman = city ? `${gmt} (${city})` : gmt;

      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const dateReadable = `${reset.getDate()} ${months[reset.getMonth()]} ${reset.getFullYear()}`;

      return `Claude usage limit reached. Your limit will reset at **${timeStr} ${tzHuman}** - ${dateReadable}`;
    });
  } catch {
    return text;
  }
}
