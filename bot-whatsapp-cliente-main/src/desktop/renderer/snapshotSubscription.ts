type SnapshotSubscriptionOptions<T> = {
  load: (signal: AbortSignal) => Promise<T>;
  listen?: (receive: (snapshot: T) => void, fail: () => void) => () => void;
  receive: (snapshot: T) => void;
  onError?: (error?: unknown) => void;
  intervalMs: number;
  maxSilenceMs?: number;
};

// HTTP is also a watchdog for proxies which accept SSE but stop forwarding it.
// Only one HTTP request may run at a time; a stream update supersedes older HTTP data.
export function subscribeSnapshots<T>(options: SnapshotSubscriptionOptions<T>) {
  let active = true;
  let suspended = typeof document !== "undefined" && document.visibilityState === "hidden";
  let transportGeneration = 0;
  let streamRevision = 0;
  let lastStreamAt = 0;
  let streamFailed = false;
  let lastResumeAt = 0;
  let controller: AbortController | undefined;
  let stopListening: (() => void) | undefined;

  const refresh = async () => {
    if (!active || suspended || controller) return;
    const request = new AbortController();
    controller = request;
    const generation = transportGeneration;
    const revision = streamRevision;
    try {
      const snapshot = await options.load(request.signal);
      if (active && !request.signal.aborted && generation === transportGeneration && revision === streamRevision) options.receive(snapshot);
    } catch (error) {
      if (active && !request.signal.aborted && generation === transportGeneration) options.onError?.(error);
    } finally {
      if (controller === request) controller = undefined;
    }
  };

  const disconnect = () => {
    transportGeneration++;
    controller?.abort();
    controller = undefined;
    stopListening?.();
    stopListening = undefined;
  };

  const connect = () => {
    const generation = transportGeneration;
    stopListening = options.listen?.((snapshot) => {
      if (!active || suspended || generation !== transportGeneration) return;
      streamRevision += 1;
      lastStreamAt = Date.now();
      streamFailed = false;
      options.receive(snapshot);
    }, () => {
      if (!active || suspended || generation !== transportGeneration) return;
      streamFailed = true;
      options.onError?.();
      void refresh();
    });
    void refresh();
  };

  const suspend = () => {
    if (!active || suspended) return;
    suspended = true;
    disconnect();
  };

  const resume = () => {
    if (!active || (typeof document !== "undefined" && document.visibilityState === "hidden")) return;
    if (!suspended && Date.now() - lastResumeAt < 500) return;
    lastResumeAt = Date.now();
    disconnect();
    suspended = false;
    lastStreamAt = 0;
    streamFailed = false;
    connect();
  };

  const visibilityChanged = () => {
    if (document.visibilityState === "hidden") suspend();
    else if (suspended) resume();
  };
  const pageShown = (event: PageTransitionEvent) => {
    if (suspended || event.persisted) resume();
  };
  const focused = () => {
    if (suspended) resume();
    else if (!lastStreamAt || streamFailed || Date.now() - lastStreamAt >= (options.maxSilenceMs ?? options.intervalMs)) void refresh();
  };

  if (!suspended) connect();
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", visibilityChanged);
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", suspend);
    window.addEventListener("pageshow", pageShown);
    window.addEventListener("focus", focused);
    window.addEventListener("online", resume);
  }

  const timer = setInterval(() => {
    if (!lastStreamAt || streamFailed || Date.now() - lastStreamAt >= (options.maxSilenceMs ?? options.intervalMs)) {
      void refresh();
    }
  }, options.intervalMs);

  return () => {
    active = false;
    clearInterval(timer);
    disconnect();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visibilityChanged);
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", suspend);
      window.removeEventListener("pageshow", pageShown);
      window.removeEventListener("focus", focused);
      window.removeEventListener("online", resume);
    }
  };
}
