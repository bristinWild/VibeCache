export type TechnologyDimension =
  'framework' | 'auth' | 'orm' | 'database' | 'deployment';

export type TechnologyDetection =
  | {
      status: 'detected';
      value: string;
      evidenceIds: string[];
    }
  | {
      status: 'unknown';
      evidenceIds: string[];
    }
  | {
      status: 'ambiguous';
      candidates: string[];
      evidenceIds: string[];
    };

export interface ProjectFingerprint {
  repositoryPath: string;
  framework: TechnologyDetection;
  auth: TechnologyDetection;
  orm: TechnologyDetection;
  database: TechnologyDetection;
  deployment: TechnologyDetection;
  capabilities: Array<{
    id: string;
    evidenceIds: string[];
  }>;
}
