import {
  listen,
  type ConnectionOptions,
  type Listener,
  type Notification,
} from '@kequtech/pgclear';

interface Subscriber {
  onNotification(notification: Notification): void;
  onDisconnect(error: unknown): void;
}
interface Channel {
  readonly subscribers: Set<Subscriber>;
  readonly ready: Promise<void>;
}
interface Generation {
  readonly controller: AbortController;
  readonly listener: Promise<Listener>;
  readonly channels: Map<string, Channel>;
  changes: Promise<void>;
}
export interface Subscription {
  readonly ready: Promise<void>;
  release(): Promise<void>;
}

// Example application policy: report consumer failures without interrupting other subscribers.
function deliver(work: () => void): void {
  void Promise.resolve().then(work).catch(console.error);
}

/** Consumer example, not a pgclear export. Authorization and reconciliation belong to the caller. */
export class SharedListener {
  #current: Generation | undefined;
  #cleanup = Promise.resolve();

  constructor(private readonly connection: ConnectionOptions) {}

  subscribe(channel: string, subscriber: Subscriber): Subscription {
    const generation = this.#current ?? this.#open();
    let entry = generation.channels.get(channel);
    if (!entry) {
      entry = {
        subscribers: new Set(),
        ready: this.#change(generation, (listener) =>
          listener.subscribe(channel, { timeoutMs: 5000 }),
        ),
      };
      generation.channels.set(channel, entry);
    }
    // Each subscription has its own identity, even when callbacks are reused.
    const member: Subscriber = {
      onNotification: (notification) => subscriber.onNotification(notification),
      onDisconnect: (error) => subscriber.onDisconnect(error),
    };
    entry.subscribers.add(member);
    const owned = entry;
    let released: Promise<void> | undefined;
    return {
      ready: entry.ready,
      release: () => {
        if (released) return released;
        owned.subscribers.delete(member);
        if (owned.subscribers.size || generation.channels.get(channel) !== owned) {
          released = Promise.resolve();
        } else {
          // Remove and enqueue synchronously: a replacement queues LISTEN after this UNLISTEN,
          // including when initial connection/registration has not finished yet.
          generation.channels.delete(channel);
          released = this.#change(generation, (listener) =>
            listener.unsubscribe(channel, { timeoutMs: 5000 }),
          );
        }
        return released;
      },
    };
  }

  /** Stop this generation. A later subscribe may start a replacement; stop accepting app work first at shutdown. */
  stop(): Promise<void> {
    if (this.#current) this.#invalidate(this.#current, new Error('Notification owner stopped.'));
    return this.#cleanup;
  }

  #open(): Generation {
    const controller = new AbortController();
    const generation: Generation = {
      controller,
      channels: new Map(),
      changes: Promise.resolve(),
      // Wait for old client resources before opening their replacement.
      listener: this.#cleanup.then(() =>
        listen(this.connection, {
          channels: [],
          reconnect: false,
          signal: controller.signal,
          timeoutMs: 5000,
          onStatus: (status) => {
            if (status.state === 'disconnected') this.#invalidate(generation, status.error);
          },
          onNotification: (notification) => {
            const entry = generation.channels.get(notification.channel);
            for (const member of entry?.subscribers ?? []) {
              deliver(() => {
                if (this.#current === generation && entry!.subscribers.has(member))
                  return member.onNotification(notification);
              });
            }
          },
        }),
      ),
    };
    this.#current = generation;
    void generation.listener.catch((error: unknown) => this.#invalidate(generation, error));
    return generation;
  }

  #change(generation: Generation, work: (listener: Listener) => Promise<void>): Promise<void> {
    const change = generation.changes.then(async () => {
      const listener = await generation.listener;
      if (this.#current !== generation) throw new Error('Notification generation ended.');
      await work(listener);
    });
    generation.changes = change.catch((error: unknown) => this.#invalidate(generation, error));
    return change;
  }

  #invalidate(generation: Generation, error: unknown): void {
    if (this.#current !== generation) return;
    // Fence stale callbacks before aborting connecting or registering work.
    this.#current = undefined;
    // Publish cleanup before abort: connection observers can synchronously create a replacement.
    this.#cleanup = generation.listener
      .then(
        (listener) => listener.close(),
        () => {},
      )
      .catch(console.error);
    generation.controller.abort();
    for (const entry of generation.channels.values()) {
      for (const member of entry.subscribers) deliver(() => member.onDisconnect(error));
    }
    generation.channels.clear();
  }
}
