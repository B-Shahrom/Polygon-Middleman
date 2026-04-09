export interface Problem {
  id: number;
  owner: string;
  name: string;
  deleted: boolean;
  favourite: boolean;
  accessType: 'READ' | 'WRITE' | 'OWNER';
  revision: number;
  latestPackage?: number;
  modified: boolean;
}

export interface ProblemInfo {
  inputFile: string;
  outputFile: string;
  interactive: boolean;
  timeLimit: number;
  memoryLimit: number;
}

export interface Statement {
  encoding: string;
  name: string;
  legend: string;
  input: string;
  output: string;
  scoring: string;
  interaction: string;
  notes: string;
  tutorial: string;
}

export interface ResourceAdvancedProperties {
  forTypes: string;
  main: boolean;
  stages: string[];
  assets: string[];
}

export interface PolygonFile {
  name: string;
  modificationTimeSeconds: number;
  length: number;
  sourceType?: string;
  resourceAdvancedProperties?: ResourceAdvancedProperties;
}

export interface FilesResult {
  resourceFiles: PolygonFile[];
  sourceFiles: PolygonFile[];
  auxFiles: PolygonFile[];
}

export type SolutionTag = 'MA' | 'OK' | 'RJ' | 'TL' | 'TO' | 'TM' | 'WA' | 'PE' | 'ML' | 'RE' | 'NR' | 'FL';

export interface Solution {
  name: string;
  modificationTimeSeconds: number;
  length: number;
  sourceType: string;
  tag: SolutionTag;
}

export interface Test {
  index: number;
  manual: boolean;
  input?: string;
  description?: string;
  useInStatements: boolean;
  scriptLine?: string;
  group?: string;
  points?: number;
  inputForStatement?: string;
  outputForStatement?: string;
  verifyInputOutputForStatements?: boolean;
}

export interface TestGroup {
  name: string;
  pointsPolicy: 'COMPLETE_GROUP' | 'EACH_TEST';
  feedbackPolicy: 'COMPLETE' | 'ICPC' | 'POINTS' | 'NONE';
  dependencies: string[];
}

export interface Package {
  id: number;
  revision: number;
  creationTimeSeconds: number;
  state: 'PENDING' | 'RUNNING' | 'READY' | 'FAILED';
  comment: string;
  type: 'standard' | 'linux' | 'windows';
}

export interface ValidatorTest {
  index: number;
  input: string;
  expectedVerdict: 'VALID' | 'INVALID';
  testset?: string;
  group?: string;
}

export interface CheckerTest {
  index: number;
  input: string;
  output: string;
  answer: string;
  expectedVerdict: 'OK' | 'WRONG_ANSWER' | 'CRASHED' | 'PRESENTATION_ERROR';
}

export interface PolygonResponse<T = unknown> {
  status: 'OK' | 'FAILED';
  comment?: string;
  result?: T;
}
