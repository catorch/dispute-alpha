/** Minimal stroke icons (24px grid, 1.7px stroke) in the spirit of SF Symbols. Decorative by default. */
import type { SVGProps } from "react";

const P = {
  home: "M3.5 10.5 12 4l8.5 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-4v-6h-6v6H5A1.5 1.5 0 0 1 3.5 19z",
  people: "M16 19v-1.2A3.8 3.8 0 0 0 12.2 14H7.8A3.8 3.8 0 0 0 4 17.8V19M10 10.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5M20 19v-1.2a3.8 3.8 0 0 0-2.6-3.6M15.5 4.3a3.25 3.25 0 0 1 0 6.1",
  letter: "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5zM4.5 6.5l7.5 6 7.5-6",
  check: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17M8.5 12.2l2.4 2.4 4.6-5",
  person: "M12 11.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5M5 20a7 7 0 0 1 14 0",
  building: "M4.5 20.5V5.5A1.5 1.5 0 0 1 6 4h7a1.5 1.5 0 0 1 1.5 1.5v15M14.5 9.5H18a1.5 1.5 0 0 1 1.5 1.5v9.5M3 20.5h18M8 8h3M8 11.5h3M8 15h3",
  template: "M6.5 3.5h7l4 4v12a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1M13.5 3.5v4h4M8.5 12h7M8.5 15.5h7",
  flag: "M5.5 21V4.5M5.5 4.5h11l-2 4 2 4h-11",
  shield: "M12 3.5 5 6.3v5.2c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6.3zM9 12l2.2 2.2L15.2 10",
  bell: "M18 15.5V11a6 6 0 1 0-12 0v4.5L4.5 17.5h15zM10 20.5a2.2 2.2 0 0 0 4 0",
  logout: "M14.5 7V5.5A1.5 1.5 0 0 0 13 4H6a1.5 1.5 0 0 0-1.5 1.5v13A1.5 1.5 0 0 0 6 20h7a1.5 1.5 0 0 0 1.5-1.5V17M10 12h10.5M17.5 8.5 21 12l-3.5 3.5",
  plus: "M12 5v14M5 12h14",
  x: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  chevronRight: "M9.5 6l6 6-6 6",
  chevronLeft: "M14.5 6l-6 6 6 6",
  upload: "M12 15.5V4.5M7.5 9 12 4.5 16.5 9M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15",
  download: "M12 4.5v11M7.5 11l4.5 4.5 4.5-4.5M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15",
  doc: "M7 3.5h6.5l4.5 4.5v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1M13.5 3.5V8H18",
  chart: "M4.5 19.5h15M7.5 16v-4M12 16V8M16.5 16v-6",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19.4 13.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.3a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7h-.3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1v-.3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.3a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1",
  clock: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17M12 7.5V12l3 2",
  alert: "M12 4 2.8 19.5h18.4zM12 10v4.5M12 17.2v.1",
  info: "M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17M12 11v5.5M12 7.8v.1",
  search: "M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14M20.5 20.5l-5-5",
  lock: "M6.5 10.5h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3",
  listBullet: "M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01",
  listNumber: "M10 6.5h10M10 12h10M10 17.5h10M4 5.5l1.5-1v4M3.8 13.2a1.3 1.3 0 0 1 2.4.6c0 .9-2.4 1.9-2.4 2.7h2.5",
  undo: "M9 14.5 4.5 10 9 5.5M4.5 10H15a4.5 4.5 0 0 1 0 9h-3",
  redo: "M15 14.5 19.5 10 15 5.5M19.5 10H9a4.5 4.5 0 0 0 0 9h3",
  braces: "M8 4.5c-1.7 0-2.5.8-2.5 2.5v2.5c0 1.2-.8 2.5-2 2.5 1.2 0 2 1.3 2 2.5V17c0 1.7.8 2.5 2.5 2.5M16 4.5c1.7 0 2.5.8 2.5 2.5v2.5c0 1.2.8 2.5 2 2.5-1.2 0-2 1.3-2 2.5V17c0 1.7-.8 2.5-2.5 2.5",
  repeat: "M17 3.5l3 3-3 3M4 11.5v-1a4 4 0 0 1 4-4h12M7 20.5l-3-3 3-3M20 12.5v1a4 4 0 0 1-4 4H4",
  sun: "M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4",
  moon: "M20 14.2A8 8 0 0 1 9.8 4a8 8 0 1 0 10.2 10.2",
  display: "M4.5 5h15A1.5 1.5 0 0 1 21 6.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 15.5v-9A1.5 1.5 0 0 1 4.5 5M8.5 20.5h7M12 17v3.5",
  inbox: "M4 13.5 6.3 5.6A1.5 1.5 0 0 1 7.7 4.5h8.6a1.5 1.5 0 0 1 1.4 1.1L20 13.5v5A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5zM4 13.5h4.5l1.5 2.5h4l1.5-2.5H20",
} as const;
export type IconName = keyof typeof P;

export function Icon({ name, className = "size-[18px]", title, ...rest }: { name: IconName; title?: string } & SVGProps<SVGSVGElement>) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative (aria-hidden) unless a title is passed, which renders <title>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? "img" : undefined} {...rest}>
      {title && <title>{title}</title>}
      <path d={P[name]} />
    </svg>
  );
}

/** Brand mark: a rounded tile with a shield-check glyph. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="da-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2997ff" />
          <stop offset="1" stopColor="#5e5ce6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#da-logo)" />
      <path d="M16 7.5 9.5 10v5c0 4 2.7 7.1 6.5 8.5 3.8-1.4 6.5-4.5 6.5-8.5v-5z" fill="white" fillOpacity=".95" />
      <path d="m13 15.6 2.1 2.1 4-4.2" fill="none" stroke="#3b6ff0" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Logo size={size} />
      <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Dispute Alpha</span>
    </span>
  );
}
