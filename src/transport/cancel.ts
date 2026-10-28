import type { Configuration } from '../config/index.js';
import { DriverError } from '../errors.js';
import { int32, uint32 } from '../protocol/framing.js';
import { deadline } from '../connection/timing.js';
import { Transport } from './index.js';

/** Protocol 3.0 cancellation uses its own verified transport, without an authentication exchange. */
export function cancel(
  config: Configuration,
  pid: number,
  secret: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let sent = false,
      abandoned = false,
      failure: Error | undefined;
    const abort = () => {
      abandoned = true;
      transport.destroy();
    };
    const finish = (error: Error) => {
      failure ??= error;
      transport.destroy();
    };
    const transport = new Transport(config, {
      ready() {
        sent = true;
        transport.write(Buffer.concat([int32(16), int32(80877102), uint32(pid), uint32(secret)]));
      },
      data() {
        finish(new DriverError('PGCLEAR_PROTOCOL', 'Unexpected cancellation response.'));
      },
      error: finish,
      closed() {
        stop();
        signal.removeEventListener('abort', abort);
        if (abandoned) resolve();
        else if (failure) reject(failure);
        else if (!sent)
          reject(
            new DriverError(
              'PGCLEAR_CONNECTION_LOST',
              'Cancellation transport closed before dispatch.',
            ),
          );
        else resolve();
      },
    });
    const stop = deadline(5000, () =>
      finish(new DriverError('PGCLEAR_TIMEOUT', 'Cancellation cleanup deadline expired.')),
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else transport.open();
  });
}
