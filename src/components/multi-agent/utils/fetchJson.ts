/** 解析 `{ success, data }` 回應；失敗時拋出帶伺服器訊息的錯誤。 */
export async function readData<T>(responsePromise: Promise<Response>): Promise<T> {
  const response = await responsePromise;
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const error = body?.error;
    const message = typeof error === 'string' ? error : error?.message || body?.message || `HTTP ${response.status}`;
    const err = new Error(message) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }
  return body.data as T;
}
