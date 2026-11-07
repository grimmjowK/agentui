import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { PendingPermissionRequest } from '../../types/types';
import { elicitationOptions, elicitationUrl, isRecord, validateElicitationContent } from '../../../../../shared/elicitation';
import { Confirmation, ConfirmationTitle, ConfirmationActions, ConfirmationAction } from '../../../../shared/view/ui';

type Props = {
  request: PendingPermissionRequest;
  expired: boolean;
  onDecision: (id: string, decision: { updatedInput?: unknown }) => void;
};

export default function CodexElicitationPanel({ request, expired, onDecision }: Props) {
  const { t } = useTranslation('chat');
  const input = (request.input ?? {}) as Record<string, any>;
  const schema = isRecord(input.requestedSchema) ? input.requestedSchema : {};
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(
    Object.entries(properties).filter(([, field]) => isRecord(field) && field.default !== undefined)
      .map(([key, field]) => [key, field.default]),
  ));
  const [json, setJson] = useState('{}');
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const isUrl = input.mode === 'url';
  const url = elicitationUrl(input.url);
  const simple = schema.type === 'object' && Object.values(properties).every((field) => isRecord(field)
    && (['string', 'number', 'integer', 'boolean'].includes(field.type)
      || (field.type === 'array' && isRecord(field.items) && elicitationOptions(field.items))));
  const disabled = expired || submitted;
  const setValue = (key: string, value: unknown) => setValues((previous) => {
    const next = { ...previous, [key]: value };
    if (value === undefined) delete next[key];
    return next;
  });
  const respond = (action: 'accept' | 'decline' | 'cancel') => {
    let content: unknown = null;
    if (action === 'accept' && !isUrl) {
      try { content = simple ? values : JSON.parse(json); }
      catch { setError(t('codex.elicitation.invalidJson', 'Enter valid JSON.')); return; }
      const validationError = validateElicitationContent(schema, content);
      if (validationError) {
        const message = t(`codex.elicitation.validation.${validationError.code}`, validationError.params);
        setError(t('codex.elicitation.validation.atPath', { path: validationError.path, message }));
        return;
      }
    }
    setError(null);
    setSubmitted(true);
    onDecision(request.requestId, { updatedInput: { action, content, _meta: null } });
  };
  const controlClass = 'w-full rounded-md border bg-background px-2 py-1 text-sm';
  return (
    <Confirmation approval="pending">
      <ConfirmationTitle>{t('codex.elicitation.title', { defaultValue: 'Codex · {{server}} · Response needed', server: String(input.serverName ?? 'MCP') })}</ConfirmationTitle>
      <div className="whitespace-pre-wrap text-sm">{String(input.message ?? '')}</div>
      {isUrl ? (
        <div className="break-all text-sm">
          {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline">{t('codex.elicitation.openLink', 'Open link')}: {url}</a>
            : <span role="alert">{t('codex.elicitation.invalidUrl', 'Invalid or unsupported URL. Decline or cancel this request.')}</span>}
          <p className="mt-1 text-xs text-muted-foreground">{t('codex.elicitation.urlHint', 'Finish the steps on the page, then click Done.')}</p>
        </div>
      ) : simple ? (
        <div className="max-h-80 space-y-3 overflow-auto">
          {Object.entries(properties).map(([key, field]) => {
            const options = elicitationOptions(field.type === 'array' ? field.items : field);
            return (
              <label key={key} className="block space-y-1 text-sm">
                <span>{field.title ?? key}{schema.required?.includes(key) ? ' *' : ''}</span>
                {field.description && <span className="block text-xs text-muted-foreground">{field.description}</span>}
                {field.type === 'boolean' ? (
                  <select className={controlClass} disabled={disabled} value={values[key] === undefined ? '' : String(values[key])}
                    onChange={(event) => setValue(key, event.target.value === '' ? undefined : event.target.value === 'true')}>
                    <option value="">{t('codex.elicitation.select', 'Select…')}</option><option value="true">{t('codex.elicitation.yes', 'Yes')}</option><option value="false">{t('codex.elicitation.no', 'No')}</option>
                  </select>
                ) : options ? (
                  <select className={controlClass} disabled={disabled} multiple={field.type === 'array'}
                    value={values[key] as string | string[] ?? (field.type === 'array' ? [] : '')}
                    onChange={(event) => setValue(key, field.type === 'array'
                      ? Array.from(event.target.selectedOptions, (option) => option.value) : event.target.value || undefined)}>
                    {field.type !== 'array' && <option value="">{t('codex.elicitation.select', 'Select…')}</option>}
                    {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                ) : (
                  <input className={controlClass} disabled={disabled} value={String(values[key] ?? '')}
                    type={['number', 'integer'].includes(field.type) ? 'number' : 'text'}
                    step={field.type === 'integer' ? 1 : 'any'}
                    onChange={(event) => setValue(key, field.type === 'string' ? event.target.value
                      : event.target.value === '' ? undefined : Number(event.target.value))} />
                )}
              </label>
            );
          })}
        </div>
      ) : (
        <label className="space-y-1 text-sm">{t('codex.elicitation.jsonLabel', 'Response (JSON)')}
          <textarea className={controlClass} rows={5} disabled={disabled} value={json} onChange={(event) => setJson(event.target.value)} />
          <details><summary>{t('codex.elicitation.viewSchema', 'View field requirements')}</summary><pre className="max-h-48 overflow-auto text-xs">{JSON.stringify(schema, null, 2)}</pre></details>
        </label>
      )}
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
      {expired && <p className="text-xs text-muted-foreground">{t('codex.approvals.expired', 'Expired')}</p>}
      {submitted && <p className="text-xs text-muted-foreground">{t('codex.elicitation.submitted', 'Submitted, waiting for response.')}</p>}
      <ConfirmationActions>
        <ConfirmationAction variant="outline" disabled={disabled} onClick={() => respond('cancel')}>{t('codex.elicitation.cancel', 'Cancel')}</ConfirmationAction>
        <ConfirmationAction variant="outline" disabled={disabled} onClick={() => respond('decline')}>{t('codex.approvals.decline', 'Deny')}</ConfirmationAction>
        <ConfirmationAction disabled={disabled || (isUrl && !url)} onClick={() => respond('accept')}>{isUrl ? t('codex.elicitation.done', 'Done') : t('codex.elicitation.submit', 'Submit')}</ConfirmationAction>
      </ConfirmationActions>
    </Confirmation>
  );
}
