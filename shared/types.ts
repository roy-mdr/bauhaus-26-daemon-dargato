// ---------- World / street graph ----------

export interface Vec2 {
  x: number;
  z: number;
}

export type NodeKind = 'junction' | 'deadend' | 'plaza' | 'start' | 'home' | 'bend';
export type EdgeKind = 'main' | 'street' | 'alley' | 'path';
export type Surface = 'asphalt' | 'cobble' | 'paved' | 'gravel';
export type EdgeEffect = 'none' | 'fog' | 'puddles' | 'echo' | 'wind';

export type LandmarkKind =
  | 'red-door'
  | 'red-lamp'
  | 'red-chair'
  | 'red-umbrella'
  | 'red-window'
  | 'red-bicycle'
  | 'red-scarf'
  | 'silhouette'
  | 'roof-cat';

export type DiscoveryKind = 'fish-bones' | 'red-collar' | 'sleeping-cat' | 'mirror' | 'yarn' | 'empty-bowl';

export interface GraphNode {
  id: number;
  x: number;
  z: number;
  kind: NodeKind;
  /** radius of the open junction / plaza area */
  r: number;
  /** grid coordinates the node was generated from (-1 for stubs) */
  gi: number;
  gj: number;
  /** 0 at start, 1 at home (graph distance ratio) */
  progress: number;
  discovery?: DiscoveryKind;
  edges: number[];
}

export interface GraphEdge {
  id: number;
  a: number;
  b: number;
  kind: EdgeKind;
  width: number;
  surface: Surface;
  length: number;
  /** cost multiplier >= 1 (narrow, dark or rough paths are slower to traverse) */
  traversability: number;
  /** 0..1, how visible landmarks are along this edge */
  landmarkVisibility: number;
  /** 0..1, how strongly route hints can appear on this edge */
  hintStrength: number;
  effect: EdgeEffect;
  curved: boolean;
  /** polyline from node a to node b */
  points: Vec2[];
  /** cumulative length at each point */
  cum: number[];
}

export interface Landmark {
  id: number;
  kind: LandmarkKind;
  nodeId: number;
  /** street the landmark marks (it sits at the corner of this edge) */
  edgeId: number;
  x: number;
  z: number;
  facing: number;
  /** true: lies on a good route home, ambiguous: may lead to a detour, memory: echoes an earlier place */
  meaning: 'true' | 'ambiguous' | 'memory';
}

export interface WorldStats {
  nodes: number;
  edges: number;
  loops: number;
  deadEnds: number;
  tJunctions: number;
  crossroads: number;
  plazas: number;
  alleys: number;
  paths: number;
  curved: number;
  mainStreets: number;
  shortestPathLength: number;
  junctionsOnPath: number;
  estDurationSec: number;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export interface WorldParams {
  cols: number;
  rows: number;
  spacing: number;
  jitter: number;
  removeNodeChance: number;
  extraEdgeChance: number;
  diagonalChance: number;
  curveChance: number;
  stubCount: number;
  /** desired shortest path length start -> home (world units) */
  targetPathLength: number;
  /** nominal cat speed used to estimate duration */
  nominalSpeed: number;
}

export interface World {
  seed: string;
  params: WorldParams;
  nodes: GraphNode[];
  edges: GraphEdge[];
  landmarks: Landmark[];
  start: number;
  home: number;
  /** the node the cat initially faces toward */
  startEdge: number;
  stats: WorldStats;
  /** graph distance (cost-weighted) from every node to home */
  distHome: number[];
  attempts: number;
}

// ---------- Roles ----------

export type SenseId = 'vision' | 'direction' | 'memory' | 'instinct' | 'hearing' | 'emotion' | 'heartbeat';

export interface RoleRef {
  sense: SenseId;
  /** variant B steers a different setting with the same input */
  variant: boolean;
}

// ---------- Cat ----------

export type CatState =
  | 'idle'
  | 'walking'
  | 'trotting'
  | 'paused'
  | 'sniffing'
  | 'hesitating'
  | 'looking'
  | 'alert'
  | 'frightened'
  | 'recovering'
  | 'resting'
  | 'investigating'
  | 'arriving'
  | 'home'
  | 'sleeping';

export interface CatInternals {
  fatigue: number;
  calm: number;
  curiosity: number;
  caution: number;
  homeward: number;
  lost: number;
  energy: number;
  perception: number;
  acuity: number;
  redGain: number;
  soundGain: number;
  explore: number;
  rest: number;
  farHearing: number;
  heartbeat: number;
  direction: number;
  memory: number;
}

export interface OptionScore {
  edgeId: number;
  toNode: number;
  turn: number; // radians, + = left
  total: number;
  terms: Record<string, number>;
}

export type HintKind = 'red-glow' | 'reflection' | 'pawprints' | 'sound' | 'silhouette' | 'clarity';

export interface Hint {
  id: number;
  kind: HintKind;
  edgeId: number;
  /** junction node from which the hint is seen (hint covers the first part of the edge leaving this node) */
  nodeId: number;
  strength: number;
  /** visible strength after perception etc. (computed by server) */
  visible: number;
  t0: number;
  until: number;
  source: string;
}

export type WorldEventKind =
  | 'memory-sound'
  | 'memory-flash'
  | 'distant-red-light'
  | 'familiar-sound'
  | 'deja-vu'
  | 'roof-cat'
  | 'red-balloon'
  | 'home-chorus'
  | 'startle'
  | 'recovered'
  | 'discovery'
  | 'heartbeat';

export interface WorldEvent {
  id: number;
  kind: WorldEventKind;
  x: number;
  z: number;
  t0: number;
  dur: number;
  strength: number;
  text?: string;
  data?: Record<string, number | string>;
}

export type Phase = 'lobby' | 'intro' | 'journey' | 'arrival' | 'sleep' | 'summary';
