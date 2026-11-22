type IpcChannel = {
  connected?: boolean;
  send?: (message: any, callback?: (error: Error | null) => void) => boolean;
};

/** A peer can disconnect between checking connected and sending a message. */
export function sendWorkerMessage(channel: IpcChannel, message: unknown, onError: (error: Error) => void = () => undefined) {
  let reported = false;
  const fail = (error: Error) => { if (!reported) { reported = true; onError(error); } };
  if (!channel.connected || !channel.send) {
    fail(new Error("Canal do worker desconectado."));
    return false;
  }
  try {
    // A false return value means backpressure, not necessarily disconnection.
    channel.send(message, error => { if (error) fail(error); });
    return true;
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
    return false;
  }
}
