/**
 * Wrapper for a table that may scroll (S6, axe `scrollable-region-focusable`).
 * Only while its content overflows does it become a named, focusable region,
 * so keyboard users can scroll it with the arrow keys; otherwise it adds no tab stop.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

export function TableWrap({ label, scroll = false, children }: { label: string; scroll?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflows(el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className={`table-wrap${scroll ? ' table-scroll' : ''}`}
      {...(overflows ? { tabIndex: 0, role: 'region', 'aria-label': label } : {})}
    >
      {children}
    </div>
  );
}
