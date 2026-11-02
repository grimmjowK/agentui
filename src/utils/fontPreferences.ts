/**
 * 界面中英文字体偏好（设置 → 外观）。
 *
 * 原理：font-family 里英文字体在前、中文字体在后。英文字体不含汉字字形，
 * 汉字会逐个回落到后面的中文字体，于是中英文各用各的字体，不需要 unicode-range。
 * 选项存 localStorage，启动时在 React 渲染前写成 :root 上的 CSS 变量（见 index.css body）。
 */

export type FontOption = { id: string; label: string; stack: string };

/** 英文字体：都不含汉字字形，保证汉字能回落到中文字体 */
export const LATIN_FONTS: FontOption[] = [
  { id: 'system', label: 'System (SF Pro / Segoe UI)', stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto' },
  { id: 'helvetica-neue', label: 'Helvetica Neue', stack: '"Helvetica Neue"' },
  { id: 'avenir-next', label: 'Avenir Next', stack: '"Avenir Next"' },
  { id: 'inter', label: 'Inter', stack: 'Inter' },
  { id: 'arial', label: 'Arial', stack: 'Arial' },
];

export const CJK_FONTS: FontOption[] = [
  { id: 'lantinghei', label: '兰亭黑-简', stack: '"Lantinghei SC", "兰亭黑-简"' },
  { id: 'pingfang', label: '苹方 PingFang SC', stack: '"PingFang SC"' },
  { id: 'hiragino', label: '冬青黑 Hiragino Sans GB', stack: '"Hiragino Sans GB"' },
  { id: 'source-han', label: '思源黑体 Source Han Sans', stack: '"Source Han Sans SC", "Noto Sans CJK SC"' },
  { id: 'yahei', label: '微软雅黑 Microsoft YaHei', stack: '"Microsoft YaHei"' },
];

export const DEFAULT_LATIN_FONT = 'system';
export const DEFAULT_CJK_FONT = 'lantinghei';

const STORAGE_KEY = { latin: 'uiFontLatin', cjk: 'uiFontCjk' } as const;
export type FontSlot = keyof typeof STORAGE_KEY;

const OPTIONS: Record<FontSlot, FontOption[]> = { latin: LATIN_FONTS, cjk: CJK_FONTS };
const DEFAULTS: Record<FontSlot, string> = { latin: DEFAULT_LATIN_FONT, cjk: DEFAULT_CJK_FONT };

export function getFontPreference(slot: FontSlot): string {
  const saved = localStorage.getItem(STORAGE_KEY[slot]);
  return OPTIONS[slot].some((option) => option.id === saved) ? saved! : DEFAULTS[slot];
}

function stackOf(slot: FontSlot, id: string): string {
  return (OPTIONS[slot].find((option) => option.id === id) ?? OPTIONS[slot][0]).stack;
}

export function applyFontPreferences(): void {
  const root = document.documentElement.style;
  root.setProperty('--font-ui-latin', stackOf('latin', getFontPreference('latin')));
  root.setProperty('--font-ui-cjk', stackOf('cjk', getFontPreference('cjk')));
}

export function setFontPreference(slot: FontSlot, id: string): void {
  localStorage.setItem(STORAGE_KEY[slot], id);
  applyFontPreferences();
}

/**
 * 字体是否已安装：与两种不同宽度的通用族比较测量宽度，任一不同即说明命中了该字体。
 * 用于过滤下拉选项，避免列出选了也没效果的字体。
 */
export function isFontInstalled(stack: string): boolean {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return true;
  const sample = 'mmmWWWiii 永和中文';
  return ['monospace', 'serif'].some((fallback) => {
    context.font = `16px ${fallback}`;
    const base = context.measureText(sample).width;
    context.font = `16px ${stack}, ${fallback}`;
    return context.measureText(sample).width !== base;
  });
}
