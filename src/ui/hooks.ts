import { useEffect, useState, useSyncExternalStore } from 'react';
import { store } from './store';

/** Blob URL for an original file in the current workspace (revoked on unmount). */
export function useFileUrl(fileKey: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const repo = store.repo();
  useEffect(() => {
    if (!fileKey) return;
    let created: string | null = null;
    let live = true;
    void repo.getFile(fileKey).then((blob) => {
      if (!live || !blob) return;
      created = URL.createObjectURL(blob);
      setUrl(created);
    });
    return () => {
      live = false;
      if (created) URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [fileKey, repo]);
  return url;
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => window.matchMedia(query).matches,
  );
}
