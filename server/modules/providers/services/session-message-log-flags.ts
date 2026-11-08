export function isSessionMessageLogEnabled(): boolean {
  const value = process.env.SESSION_MESSAGE_LOG_ENABLED;
  if (value === undefined || value.trim() === '') return true;
  return value !== '0' && value.toLowerCase() !== 'false';
}
