/** Target API. Implemented signatures are imported from src; later features stay proposals. */

import type {
  ConnectionOptions,
  OperationOptions,
  SessionInfo,
  CloseOptions,
} from '../src/index.js';
export * from '../src/index.js';

export interface Notification {
  readonly channel: string;
  readonly payload: string;
  readonly backendPid: number;
}
export type ListenerStatus =
  | { readonly state: 'connected'; readonly session: SessionInfo; readonly generation: number }
  | { readonly state: 'disconnected'; readonly error: Error; readonly generation: number }
  | { readonly state: 'reconnecting'; readonly attempt: number; readonly generation: number }
  | { readonly state: 'closed'; readonly generation: number };
export interface ListenerOptions extends OperationOptions {
  readonly channels: readonly string[];
  readonly onNotification: (notification: Notification) => void;
  readonly onStatus?: (status: ListenerStatus) => void;
  readonly reconnect?: boolean;
}
export interface Listener {
  readonly status: ListenerStatus;
  close(options?: CloseOptions): Promise<void>;
}
export declare function listen(
  connection: string | ConnectionOptions,
  options: ListenerOptions,
): Promise<Listener>;
