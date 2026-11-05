import {
  ArrowUpRight,
  ChevronRight,
  Clock,
  CloudDownload,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileText,
  FileType,
  FileVideo,
  Folder,
  FolderSearch,
  Grid2X2,
  Image,
  List,
  Lock,
  Menu,
  Plug,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  TriangleAlert,
  Upload,
  UserRound,
  Copy,
  LogOut,
  X,
} from "lucide-preact";

const icons = {
  folder: Folder,
  clock: Clock,
  star: Star,
  cloud: CloudDownload,
  settings: Settings,
  "chevron-right": ChevronRight,
  refresh: RefreshCw,
  search: Search,
  shield: ShieldCheck,
  grid: Grid2X2,
  list: List,
  lock: Lock,
  alert: TriangleAlert,
  "folder-search": FolderSearch,
  file: File,
  image: Image,
  text: FileText,
  pdf: FileType,
  video: FileVideo,
  audio: FileAudio,
  archive: FileArchive,
  download: Download,
  upload: Upload,
  user: UserRound,
  copy: Copy,
  logout: LogOut,
  x: X,
  menu: Menu,
  plug: Plug,
  sparkles: Sparkles,
  "arrow-up-right": ArrowUpRight,
};

export function Icon({ name, ...props }) {
  if (name === "portal")
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" {...props}>
        <path d="M8 5h8l4 4-3 12H7L4 9Z" />
        <path d="M9 5V3h6v2M4 9h16M9 21h6M12 10v7" />
      </svg>
    );

  const Component = icons[name] || File;
  return <Component aria-hidden="true" {...props} />;
}
