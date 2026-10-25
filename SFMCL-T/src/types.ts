export interface GameSettings {
  javaPath: string;
  javaPaths: string[];
  autoMemory: boolean;
  memoryMb: number;
  isolation: boolean;
  fullscreen: boolean;
  width: number;
  height: number;
  windowTitle: string;
  customInfo: string;
  jvmArgsEnabled: boolean;
  jvmArgs: string;
  gameArgs: string;
}
export interface VersionSettings {
  useGlobal: boolean;
  independentGroups?: GameSettingGroups;
  settings: GameSettings;
}
export interface GameSettingGroups {
  java: boolean;
  memory: boolean;
  window: boolean;
  advanced: boolean;
}
export type GameSettingGroup = keyof GameSettingGroups;
export interface Settings extends GameSettings {
  schemaVersion: number;
  gameDirs: { name: string; path: string }[];
  activeDir: string;
  activeVersion: string;
  activePlayer: string;
  theme: string;
  accent: string;
  backgroundType: string;
  background: string;
  hardwareAcceleration: boolean;
  showNotices: boolean;
  downloadTaskDisplay: string;
  downloadConcurrency: number;
  downloadCacheDir: string;
  microsoftClientId: string;
  closeOnLaunch: boolean;
}
export interface Player {
  uuid: string;
  name: string;
  online: boolean;
  skin: string;
  cape?: string;
  slim: boolean;
}
export interface Version {
  id: string;
  version: string;
  kind: string;
  loader: string;
  path: string;
  javaMajor: number;
  directory?: string;
  isolation?: boolean;
  independentSettings?: boolean;
  icon: string;
  favorite?: boolean;
  error?: string;
}
export interface FavoriteVersion extends Version {
  directory: string;
  directoryName: string;
}
export interface Java {
  path: string;
  version: string;
  major: number;
  architecture: string;
}
export type Status =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
export interface Step {
  name: string;
  status: Status;
  detail: string;
}
export interface Job {
  id: string;
  title: string;
  status: Status;
  steps: Step[];
  currentStep: number;
  downloadId?: string;
  error?: string;
  log: string[];
}
export interface Download {
  id: string;
  title: string;
  status: Status;
  downloaded: number;
  total: number;
  unknownSize: boolean;
  completed: number;
  failed: number;
  fileCount: number;
  speed: number;
  workers: number;
  steps: Step[];
  error?: string;
}
export interface Tasks {
  downloads: Download[];
  jobs: Job[];
}
export interface DownloadSpec {
  url: string;
  path: string;
  size?: number;
  sha1?: string;
  sha512?: string;
}
export interface DownloadFile {
  spec: DownloadSpec;
  status: Status;
  downloaded: number;
  total?: number;
  attempts: number;
  error?: string;
}
export interface Loader {
  kind: string;
  version: string;
  metadata: Record<string, unknown>;
}
export interface ManifestVersion {
  id: string;
  type: string;
  releaseTime: string;
  url: string;
}
export interface LocalResource {
  name: string;
  path: string;
  kind: string;
  entryType?: "file" | "resourceDirectory" | "directory";
  description: string;
  version: string;
  authors: string;
  icon: string;
  disabled: boolean;
  size: number | null;
  error?: string;
  details: Record<string, unknown>;
}
export interface Project {
  id: string;
  source: string;
  title: string;
  description: string;
  author: string;
  icon: string;
  downloads: number;
  categories: string[];
  versions: string[];
  website: string;
  body: string;
}
export interface ResourceDependency {
  projectId: string | null;
  versionId: string | null;
  name: string | null;
  kind:
    | "mod"
    | "resourcepack"
    | "shader"
    | "modpack"
    | "datapack"
    | "world"
    | "plugin"
    | "unknown";
}
export interface ResourceFile {
  id: string;
  name: string;
  version: string;
  date: string;
  gameVersions: string[];
  loaders: string[];
  file?: DownloadSpec;
  dependencies: ResourceDependency[];
}
export interface Bootstrap {
  defaultDownloadCacheDir?: string;
  backgroundPath?: string;
  settings: Settings;
  players: Player[];
  dataDir: string;
  version: string;
}
export type Page =
  "home" | "players" | "versions" | "resources" | "downloads" | "settings";
