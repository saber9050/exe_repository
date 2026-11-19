const Svg = ({ size = 16, children, ...rest }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...rest}
  >
    {children}
  </svg>
)

export const Search = (p) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20.5 20.5-3.6-3.6" />
  </Svg>
)

export const Download = (p) => (
  <Svg {...p}>
    <path d="M12 3v12" />
    <path d="m7 11 5 5 5-5" />
    <path d="M4 19h16" />
  </Svg>
)

export const Upload = (p) => (
  <Svg {...p}>
    <path d="M12 16V4" />
    <path d="m7 9 5-5 5 5" />
    <path d="M4 20h16" />
  </Svg>
)

export const Check = (p) => (
  <Svg {...p}>
    <path d="m4 12.5 5 5L20 6.5" />
  </Svg>
)

export const ShieldCheck = (p) => (
  <Svg {...p}>
    <path d="M12 3l7 3v5.5c0 4.4-2.9 8.1-7 9.5-4.1-1.4-7-5.1-7-9.5V6l7-3Z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
)

export const Box = (p) => (
  <Svg {...p}>
    <path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9L12 3Z" />
    <path d="M3.5 7.5 12 12l8.5-4.5" />
    <path d="M12 12v9" />
  </Svg>
)

export const ChevronRight = (p) => (
  <Svg {...p}>
    <path d="m9 5 7 7-7 7" />
  </Svg>
)

export const ChevronDown = (p) => (
  <Svg {...p}>
    <path d="m5 9 7 7 7-7" />
  </Svg>
)

export const ChevronLeft = (p) => (
  <Svg {...p}>
    <path d="m15 5-7 7 7 7" />
  </Svg>
)

export const Copy = (p) => (
  <Svg {...p}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a1 1 0 0 1 1-1h9" />
  </Svg>
)

export const ExternalLink = (p) => (
  <Svg {...p}>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M19 14v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Svg>
)

export const Clock = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
)

export const ArrowLeft = (p) => (
  <Svg {...p}>
    <path d="M19 12H5" />
    <path d="m11 6-6 6 6 6" />
  </Svg>
)

export const Sparkles = (p) => (
  <Svg {...p}>
    <path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9 12 3.5Z" />
    <path d="M18.5 16.5l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" />
  </Svg>
)

export const Loader = (p) => (
  <Svg {...p}>
    <path d="M12 3v3.5" />
    <path d="M12 17.5V21" />
    <path d="M3 12h3.5" />
    <path d="M17.5 12H21" />
    <path d="m5.6 5.6 2.5 2.5" />
    <path d="m15.9 15.9 2.5 2.5" />
    <path d="m18.4 5.6-2.5 2.5" />
    <path d="m8.1 15.9-2.5 2.5" />
  </Svg>
)

export const X = (p) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)

export const Info = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5" />
    <path d="M12 7.8h.01" />
  </Svg>
)

export const CircleAlert = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V13" />
    <path d="M12 16.3h.01" />
  </Svg>
)

export const CircleCheck = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12 2.5 2.5 4.5-4.5" />
  </Svg>
)

export const Package = (p) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
    <path d="M3.5 9h17" />
    <path d="M9 13.5h6" />
  </Svg>
)

export const Layers = (p) => (
  <Svg {...p}>
    <path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" />
    <path d="m3.5 12 8.5 4.5 8.5-4.5" />
    <path d="m3.5 16.5 8.5 4.5 8.5-4.5" />
  </Svg>
)

export const Terminal = (p) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="m7.5 9.5 3 2.5-3 2.5" />
    <path d="M13 14.5h4" />
  </Svg>
)

export const LogOut = (p) => (
  <Svg {...p}>
    <path d="M14 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H14" />
    <path d="M17 8.5 20.5 12 17 15.5" />
    <path d="M10 12h10.5" />
  </Svg>
)

export const LayoutDashboard = (p) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.6" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.6" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.6" />
  </Svg>
)

export const PlusCircle = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 8.5v7M8.5 12h7" />
  </Svg>
)

export const ScrollText = (p) => (
  <Svg {...p}>
    <path d="M6 3.5h9.5L19 7v13.5H6z" />
    <path d="M15 3.5V7h4" />
    <path d="M9 11h7M9 14.5h7M9 18h4" />
  </Svg>
)

export const Eye = (p) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
)

export const Server = (p) => (
  <Svg {...p}>
    <rect x="3.5" y="4" width="17" height="6.5" rx="1.8" />
    <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.8" />
    <path d="M7 7.2h.01M7 16.8h.01" />
  </Svg>
)

export const Lock = (p) => (
  <Svg {...p}>
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </Svg>
)

export const User = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="8.5" r="3.8" />
    <path d="M4.5 20c0-3.6 3.3-5.8 7.5-5.8s7.5 2.2 7.5 5.8" />
  </Svg>
)

export const Save = (p) => (
  <Svg {...p}>
    <path d="M5 4.5h11L19 8v11.5H5z" />
    <path d="M8.5 4.5v5h6v-5" />
    <rect x="8.5" y="13" width="7" height="6.5" />
  </Svg>
)

export const Tag = (p) => (
  <Svg {...p}>
    <path d="M11.6 3.5H20v8.4l-8.5 8.5-8.4-8.4 8.5-8.5Z" />
    <path d="M16 8h.01" />
  </Svg>
)

export const Users = (p) => (
  <Svg {...p}>
    <circle cx="9.5" cy="8.5" r="3.3" />
    <path d="M3.5 19.5c0-3.2 2.7-5.2 6-5.2s6 2 6 5.2" />
    <path d="M16.5 5.6a3.3 3.3 0 0 1 0 6.4" />
    <path d="M18 14.6c1.7.6 2.9 1.9 2.9 4" />
  </Svg>
)

export const Star = (p) => (
  <Svg {...p}>
    <path d="m12 3.8 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 10l5.9-.9L12 3.8Z" />
  </Svg>
)

export const Code = (p) => (
  <Svg {...p}>
    <path d="m8.5 8-4 4 4 4" />
    <path d="m15.5 8 4 4-4 4" />
    <path d="m13.5 4.5-3 15" />
  </Svg>
)

export const Archive = (p) => (
  <Svg {...p}>
    <rect x="3.5" y="4" width="17" height="4.5" rx="1.4" />
    <path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5" />
    <path d="M10 12.5h4" />
  </Svg>
)

export const ArrowUpRight = (p) => (
  <Svg {...p}>
    <path d="M7 17 17 7" />
    <path d="M9 7h8v8" />
  </Svg>
)

export const Menu = (p) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
)

export const Trash = (p) => (
  <Svg {...p}>
    <path d="M4.5 6.5h15" />
    <path d="M9.5 4h5" />
    <path d="M6.5 6.5 7.5 20h9l1-13.5" />
    <path d="M10 10v6M14 10v6" />
  </Svg>
)

export const Refresh = (p) => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 0 0-13.7-5.1L4 8" />
    <path d="M4 4v4h4" />
    <path d="M4 13a8 8 0 0 0 13.7 5.1L20 16" />
    <path d="M20 20v-4h-4" />
  </Svg>
)

export const Filter = (p) => (
  <Svg {...p}>
    <path d="M3.5 5.5h17l-6.5 7.5V20l-4-2v-5L3.5 5.5Z" />
  </Svg>
)

export const LogoMark = ({ size = 30 }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <rect width="32" height="32" rx="9" fill="url(#dsh-g)" />
    <path
      d="M11 9.5v11.2c0 .9.7 1.6 1.6 1.6h3.6c3.2 0 5.3-2.3 5.3-5.6s-2.1-5.6-5.3-5.6h-3.4"
      stroke="#fff"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <circle cx="21.2" cy="22.2" r="1.8" fill="#fff" opacity=".75" />
    <defs>
      <linearGradient id="dsh-g" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
        <stop stopColor="#4F7BFF" />
        <stop offset="1" stopColor="#2543C9" />
      </linearGradient>
    </defs>
  </svg>
)
