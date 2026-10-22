/**
 * Public base path handling (S21, design §16).
 * `normalizeBase` is shared with vite.config.ts; `assetUrl` builds every runtime
 * asset URL from the configured base so the app works under a sub-path such as
 * https://<user>.github.io/<repo>/.
 */
export function normalizeBase(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '' || trimmed === '/') return '/';
  const parts = trimmed.split('/').filter((p) => p !== '');
  if (parts.length === 0) return '/';
  return `/${parts.join('/')}/`;
}

/** Resolve a path inside `public/` against the configured base. */
export function assetUrl(path: string): string {
  const clean = path.replace(/^\/+/, '');
  return `${import.meta.env.BASE_URL}${clean}`;
}
