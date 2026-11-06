/** Shared form validation: the browser and server must agree before consuming a request. */
export const isRecord = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function elicitationOptions(schema: Record<string, any>): Array<{ value: string; label: string }> | null {
  if (Array.isArray(schema.enum)) return schema.enum.map((value: string, index: number) => ({
    value, label: schema.enumNames?.[index] ?? value,
  }));
  const options = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(options) && options.every((option) => isRecord(option) && typeof option.const === 'string')) {
    return options.map((option) => ({ value: option.const, label: option.title ?? option.const }));
  }
  return null;
}

export function validateElicitationContent(schema: unknown, content: unknown): string | null {
  if (!isRecord(content)) return '請填寫表單內容（JSON 物件）。';
  return validate(schema, content, '表單');
}

function validate(schema: unknown, value: unknown, path: string): string | null {
  if (!isRecord(schema)) return null;
  const invalid = (detail: string) => `${path}：${detail}`;
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) return invalid('值不符合要求');
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return invalid('請選擇提供的選項');
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
    if (!Array.isArray(schema[keyword])) continue;
    const matches = schema[keyword].filter((branch: unknown) => !validate(branch, value, path)).length;
    if (keyword === 'oneOf' ? matches !== 1 : keyword === 'anyOf' ? matches === 0 : matches !== schema[keyword].length) {
      return invalid('值不符合選項要求');
    }
  }
  if (Array.isArray(schema.type)) {
    return schema.type.some((type: string) => !validate({ ...schema, type }, value, path)) ? null : invalid('型別不符');
  }
  switch (schema.type) {
    case 'object': {
      if (!isRecord(value)) return invalid('請輸入物件');
      for (const key of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) return invalid(`缺少 ${key}`);
      }
      for (const [key, entry] of Object.entries(value)) {
        const property = isRecord(schema.properties) && Object.prototype.hasOwnProperty.call(schema.properties, key) ? schema.properties[key] : undefined;
        if (!property && schema.additionalProperties === false) return invalid(`不支援欄位 ${key}`);
        const error = validate(property ?? schema.additionalProperties, entry, `${path}.${key}`);
        if (error) return error;
      }
      break;
    }
    case 'string':
      if (typeof value !== 'string') return invalid('請輸入文字');
      if (schema.minLength !== undefined && value.length < schema.minLength) return invalid(`至少 ${schema.minLength} 個字元`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return invalid(`最多 ${schema.maxLength} 個字元`);
      if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return invalid('請輸入電子郵件地址');
      if (schema.format === 'uri') {
        try { new URL(value); } catch { return invalid('請輸入完整網址'); }
      }
      break;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) return invalid('請輸入有效數字');
      if (schema.minimum !== undefined && value < schema.minimum) return invalid(`最小值為 ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) return invalid(`最大值為 ${schema.maximum}`);
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return invalid('請選擇是或否');
      break;
    case 'null':
      if (value !== null) return invalid('必須為 null');
      break;
    case 'array':
      if (!Array.isArray(value)) return invalid('請輸入陣列');
      if (schema.minItems !== undefined && value.length < schema.minItems) return invalid(`至少選擇 ${schema.minItems} 項`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return invalid(`最多選擇 ${schema.maxItems} 項`);
      for (const entry of value) {
        const error = validate(schema.items, entry, path);
        if (error) return error;
      }
      break;
  }
  return null;
}

export function elicitationUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
