import type { CSSProperties } from 'react';
export type IconName =
  | 'dashboard'
  | 'video'
  | 'calendar'
  | 'link'
  | 'settings'
  | 'plus'
  | 'upload'
  | 'check'
  | 'arrow'
  | 'chevron'
  | 'clock'
  | 'folder'
  | 'shield'
  | 'download'
  | 'copy'
  | 'trash'
  | 'grip'
  | 'close'
  | 'info'
  | 'spark'
  | 'search'
  | 'play'
  | 'pause'
  | 'youtube'
  | 'facebook'
  | 'instagram'
  | 'tiktok';
const paths: Record<IconName, React.ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="11" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="18" width="7" height="3" rx="1"/></>,
  video: (
    <>
      <rect x="3" y="5" width="13" height="14" rx="3" />
      <path d="m16 10 5-3v10l-5-3M7 12h5M9.5 9.5v5" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M7 3v4m10-4v4M3 10h18m-13 5h2m4 0h2" />
    </>
  ),
  link: (
    <>
      <path
        d="m10 14 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 10a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1"
        transform="translate(1 -1) scale(.92)"
      />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h16M4 12h16M4 18h16" />
      <circle cx="8" cy="6" r="2" />
      <circle cx="16" cy="12" r="2" />
      <circle cx="10" cy="18" r="2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  upload: (
    <>
      <path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    </>
  ),
  check: <path className="check-stroke" d="m5 12 4 4L19 6" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10H3z" />,
  shield: (
    <>
      <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" />
      <path d="m8 12 3 3 5-5" />
    </>
  ),
  download: <path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="13" rx="2" />
      <path d="M16 8V3H3v13h5" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M5 6l1 15h12l1-15M9 6V3h6v3m-5 4v7m4-7v7" />
    </>
  ),
  grip: (
    <>
      <path d="M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01" strokeWidth="3" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10h.01" />
    </>
  ),
  spark: <path d="m12 2 2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6z" />,
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 6 6" />
    </>
  ),
  play: <path d="m9 5 11 7-11 7z" />,
  pause: <path d="M9 5v14m6-14v14" />,
  youtube: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="5" />
      <path d="m10 9 5 3-5 3z" fill="currentColor" strokeWidth="1" />
    </>
  ),
  facebook: <path d="M14 22V13h4l.5-4H14V6c0-1.5 1-2 2.5-2H19V1h-3c-4 0-6 2-6 6v2H7v4h3v9" />,
  instagram: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <path d="M17.5 6.5h.01" strokeWidth="3" />
    </>
  ),
  tiktok: <path d="M14 3v12a4 4 0 1 1-4-4m4-8c1 4 3 5 6 5v4c-3 0-5-1-6-3" />,
};
export function Icon({
  name,
  size = 20,
  className = '',
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      {paths[name]}
    </svg>
  );
}
export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <rect x="5" y="7" width="22" height="22" rx="6" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M11 4v6m10-6v6M6 13h20"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path d="m13 17 7 4-7 4z" fill="currentColor" />
      </svg>
    </span>
  );
}
