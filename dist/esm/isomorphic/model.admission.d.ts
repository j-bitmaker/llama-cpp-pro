import type { MemorySnapshot } from './provider.interface';
export interface AdmissionInput {
    modelId: string;
    modelBytes: number;
    currentlyLoaded: number;
    maxModels: number;
    memory: MemorySnapshot;
    estimatedMultiplier?: number;
    reserveBytes?: number;
}
export interface AdmissionResult {
    allow: boolean;
    deniedBy?: 'limit' | 'memory';
    reason?: string;
    estimatedBytes: number;
}
export declare function canAdmitModel(input: AdmissionInput): AdmissionResult;
