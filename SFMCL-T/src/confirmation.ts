export interface Confirmation {
  id: number;
  message: string;
}

const queue: (Confirmation & { resolve: (confirmed: boolean) => void })[] = [];
const listeners = new Set<() => void>();
let nextId = 0;

function emit() {
  listeners.forEach((listener) => listener());
}

export function subscribeConfirmations(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function currentConfirmation(): Confirmation | null {
  return queue[0] ?? null;
}

export function confirmAction(message: string): Promise<boolean> {
  // Never leave an action waiting when the app's dialog host is unavailable.
  if (!listeners.size) return Promise.resolve(false);
  return new Promise((resolve) => {
    queue.push({ id: ++nextId, message, resolve });
    emit();
  });
}

export function finishConfirmation(id: number, confirmed: boolean) {
  if (queue[0]?.id !== id) return;
  const request = queue.shift()!;
  emit();
  request.resolve(confirmed);
}

export function cancelConfirmations() {
  const pending = queue.splice(0);
  emit();
  pending.forEach((request) => request.resolve(false));
}
