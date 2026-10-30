/** A slow GitHub version lookup must not hold the WhatsApp connection startup. */
export function createBoundedVersionLookup(load: () => Promise<number[] | undefined>, budgetMs = 800, ttlMs = 6 * 60 * 60_000) {
  let cached: number[] | undefined;
  let pending: Promise<number[] | undefined> | undefined;
  let checkedAt: number | undefined;
  return async () => {
    if (!pending && (checkedAt === undefined || Date.now() - checkedAt >= ttlMs)) {
      checkedAt = Date.now();
      pending = Promise.resolve().then(load).then((version) => {
        if (version?.length === 3 && version.every((value) => Number.isInteger(value) && value >= 0)) cached = version;
        return cached;
      }).catch(() => cached).finally(() => { pending = undefined; });
    }
    if (cached || !pending) return cached;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending, new Promise<undefined>((resolve) => { deadline = setTimeout(() => resolve(undefined), budgetMs); })]);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  };
}
