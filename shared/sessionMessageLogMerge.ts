export type SessionLogImageLike = {
  data?: string;
  name?: string;
  mimeType?: string;
  byteLength?: number;
};

export type SessionLogMessageLike = {
  id: string;
  sessionId: string;
  timestamp: string;
  kind: string;
  role?: string;
  content?: string;
  seq?: number;
  images?: unknown;
};

function getImages(message: SessionLogMessageLike): SessionLogImageLike[] | undefined {
  if (!Array.isArray(message.images)) return undefined;
  return message.images as SessionLogImageLike[];
}

export type SessionLogSlotLike<M extends SessionLogMessageLike = SessionLogMessageLike> = {
  serverMessages: M[];
  realtimeMessages: M[];
  merged: M[];
};

const MAX_REALTIME_MESSAGES = 500;

export function compareBySeq<M extends SessionLogMessageLike>(left: M, right: M): number {
  const leftSeq = typeof left.seq === 'number' ? left.seq : Number.POSITIVE_INFINITY;
  const rightSeq = typeof right.seq === 'number' ? right.seq : Number.POSITIVE_INFINITY;
  if (leftSeq !== rightSeq) return leftSeq - rightSeq;
  return left.id.localeCompare(right.id);
}

export function upsertLogMessage<M extends SessionLogMessageLike>(
  messages: M[],
  incoming: M,
): M[] {
  const next = [...messages];
  const index = next.findIndex((message) => message.id === incoming.id);
  const previous = index >= 0 ? next[index] : undefined;
  const merged = (previous ? { ...previous, ...incoming } : incoming) as M;
  const prevImages = previous ? getImages(previous) : undefined;
  const incImages = getImages(incoming);
  if (prevImages?.length && incoming.role === 'user' && incoming.kind === 'text') {
    merged.images = incImages?.length ? incoming.images : previous?.images;
  }
  if (index >= 0) next[index] = merged;
  else next.push(merged);
  return next.sort(compareBySeq);
}

export function buildLogMerged<M extends SessionLogMessageLike>(
  slot: SessionLogSlotLike<M>,
): M[] {
  const persistent = [...slot.serverMessages].sort(compareBySeq);
  const transient = slot.realtimeMessages.filter((message) => typeof message.seq !== 'number');
  const persistentIds = new Set(persistent.map((message) => message.id));
  return [
    ...persistent,
    ...transient.filter((message) => !persistentIds.has(message.id)),
  ];
}

/**
 * Applies one realtime durable row to a session slot. Durable rows are upserted
 * into the single sequence-ordered collection; optimistic/stream rows remain at
 * the tail until the server assigns them a sequence.
 */
export function applyLogMessage<
  M extends SessionLogMessageLike,
  S extends SessionLogSlotLike<M>,
>(slot: S, message: M): S {
  if (typeof message.seq !== 'number') {
    const existingServerIdx = slot.serverMessages.findIndex((entry) => entry.id === message.id);
    if (existingServerIdx >= 0) {
      const existing = slot.serverMessages[existingServerIdx];
      const existingImages = getImages(existing);
      const incomingImages = getImages(message);
      const existingHasImageData = existingImages?.some((image) => Boolean(image?.data));
      const incomingHasImageData = incomingImages?.some((image) => Boolean(image?.data));
      if (message.role === 'user' && message.kind === 'text' && incomingHasImageData && !existingHasImageData) {
        slot.serverMessages = [...slot.serverMessages];
        slot.serverMessages[existingServerIdx] = {
          ...existing,
          images: message.images,
        };
      }
      slot.merged = buildLogMerged(slot);
      return slot;
    }

    const nextRealtime = upsertLogMessage(slot.realtimeMessages, message);
    slot.realtimeMessages = nextRealtime.length > MAX_REALTIME_MESSAGES
      ? nextRealtime.slice(-MAX_REALTIME_MESSAGES)
      : nextRealtime;
    slot.merged = buildLogMerged(slot);
    return slot;
  }

  const previous = [...slot.serverMessages, ...slot.realtimeMessages]
    .find((entry) => entry.id === message.id);
  const prevImages = previous ? getImages(previous) : undefined;
  const incomingImages = getImages(message);
  const incomingHasImageData = incomingImages?.some((image) => Boolean(image?.data));
  const withLocalImages = (
    prevImages?.length
    && message.role === 'user'
    && message.kind === 'text'
    && !incomingHasImageData
      ? { ...message, images: previous?.images }
      : message
  ) as M;
  slot.serverMessages = upsertLogMessage(slot.serverMessages, withLocalImages);
  slot.realtimeMessages = slot.realtimeMessages.filter((entry) => (
    entry.id !== message.id
    && !(message.kind === 'text' && message.role !== 'user' && entry.id === `__streaming_${message.sessionId}`)
  ));
  slot.merged = buildLogMerged(slot);
  return slot;
}

export function clearLogStreaming<
  M extends SessionLogMessageLike,
  S extends SessionLogSlotLike<M>,
>(slot: S, sessionId: string): S {
  const streamId = `__streaming_${sessionId}`;
  slot.realtimeMessages = slot.realtimeMessages.filter((entry) => (
    entry.id !== streamId
    && entry.kind !== 'stream_delta'
    && !(entry.kind === 'text' && entry.role === 'assistant' && typeof entry.seq !== 'number')
  ));
  slot.merged = buildLogMerged(slot);
  return slot;
}

/**
 * Replaces all durable rows from a fetch while retaining optimistic messages
 * and the current streaming placeholder at the tail.
 */
export function replaceWithFetched<
  M extends SessionLogMessageLike,
  S extends SessionLogSlotLike<M>,
>(
  slot: S,
  messages: M[],
): S {
  const incoming = messages
    .filter((message) => typeof message.seq === 'number')
    .sort(compareBySeq);
  const incomingIds = new Set(incoming.map((message) => message.id));
  const previous = new Map(
    [...slot.serverMessages, ...slot.realtimeMessages].map((message) => [message.id, message]),
  );
  slot.serverMessages = incoming.map((message) => {
    const local = previous.get(message.id);
    const localImages = local ? getImages(local) : undefined;
    const incomingImages = getImages(message);
    const incomingHasImageData = incomingImages?.some((image) => Boolean(image?.data));
    if (localImages?.length && message.role === 'user' && !incomingHasImageData) {
      return { ...message, images: local?.images } as M;
    }
    return message;
  });
  slot.realtimeMessages = slot.realtimeMessages.filter((message) => (
    !incomingIds.has(message.id)
    && (
      typeof message.seq !== 'number'
      && (
        message.kind === 'stream_delta'
        || (message.kind === 'text' && message.role === 'user')
      )
    )
  ));
  slot.merged = buildLogMerged(slot);
  return slot;
}
