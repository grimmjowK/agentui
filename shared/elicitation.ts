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

export type ElicitationValidationError = {
  code: string;
  path: string;
  params: Record<string, string | number>;
};

export function validateElicitationContent(schema: unknown, content: unknown): ElicitationValidationError | null {
  if (!isRecord(content)) return { code: 'object', path: '$', params: {} };
  return validate(schema, content, '$');
}

function validate(schema: unknown, value: unknown, path: string): ElicitationValidationError | null {
  if (!isRecord(schema)) return null;
  const invalid = (code: string, params: ElicitationValidationError['params'] = {}): ElicitationValidationError => ({ code, path, params });
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) return invalid('const');
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return invalid('enum');
  for (const keyword of ['oneOf', 'anyOf', 'allOf']) {
    if (!Array.isArray(schema[keyword])) continue;
    const matches = schema[keyword].filter((branch: unknown) => !validate(branch, value, path)).length;
    if (keyword === 'oneOf' ? matches !== 1 : keyword === 'anyOf' ? matches === 0 : matches !== schema[keyword].length) {
      return invalid('union');
    }
  }
  if (Array.isArray(schema.type)) {
    return schema.type.some((type: string) => !validate({ ...schema, type }, value, path)) ? null : invalid('type');
  }
  switch (schema.type) {
    case 'object': {
      if (!isRecord(value)) return invalid('object');
      for (const key of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) return invalid('required', { field: key });
      }
      for (const [key, entry] of Object.entries(value)) {
        const property = isRecord(schema.properties) && Object.prototype.hasOwnProperty.call(schema.properties, key) ? schema.properties[key] : undefined;
        if (!property && schema.additionalProperties === false) return invalid('additionalProperty', { field: key });
        const error = validate(property ?? schema.additionalProperties, entry, `${path}.${key}`);
        if (error) return error;
      }
      break;
    }
    case 'string':
      if (typeof value !== 'string') return invalid('string');
      if (schema.minLength !== undefined && value.length < schema.minLength) return invalid('minLength', { limit: schema.minLength });
      if (schema.maxLength !== undefined && value.length > schema.maxLength) return invalid('maxLength', { limit: schema.maxLength });
      if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return invalid('email');
      if (schema.format === 'uri') {
        try { new URL(value); } catch { return invalid('uri'); }
      }
      break;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) return invalid('number');
      if (schema.minimum !== undefined && value < schema.minimum) return invalid('minimum', { limit: schema.minimum });
      if (schema.maximum !== undefined && value > schema.maximum) return invalid('maximum', { limit: schema.maximum });
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return invalid('boolean');
      break;
    case 'null':
      if (value !== null) return invalid('null');
      break;
    case 'array':
      if (!Array.isArray(value)) return invalid('array');
      if (schema.minItems !== undefined && value.length < schema.minItems) return invalid('minItems', { limit: schema.minItems });
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return invalid('maxItems', { limit: schema.maxItems });
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
